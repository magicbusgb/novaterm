'use strict';
/**
 * Gestione dei terminali: SSH (ssh2), terminale locale (node-pty), SFTP ed esecuzione
 * di comandi "fuori banda" usata dall'integrazione con Claude Code.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { Client } = require('ssh2');

let pty = null;
try { pty = require('node-pty'); } catch (e) { console.warn('node-pty non disponibile:', e.message); }

const MAX_BUFFER = 256 * 1024;
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[@-Z\\-_]|[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g;

function stripAnsi(s) {
  // gestisce i \r "sovrascriventi" delle progress bar tenendo l'ultimo segmento della riga
  return s.replace(ANSI_RE, '').split('\n').map((l) => {
    const parts = l.replace(/\r$/, '').split('\r');
    return parts[parts.length - 1];
  }).join('\n');
}

function expandHome(p) {
  if (!p) return p;
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function fingerprint(key) {
  return 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
}

function truncate(s, max) {
  if (s.length <= max) return s;
  const half = Math.floor(max / 2);
  return s.slice(0, half) + `\n\n[... ${s.length - max} caratteri omessi ...]\n\n` + s.slice(-half);
}

class TerminalManager extends EventEmitter {
  /**
   * @param {import('./store').Store} store
   * @param {{askHostKey:(info:object)=>Promise<boolean>}} hooks
   */
  constructor(store, hooks) {
    super();
    this.store = store;
    this.hooks = hooks;
    this.terms = new Map();
    this.seq = 0;
  }

  list() {
    return [...this.terms.values()].map((t) => this.describe(t));
  }

  describe(t) {
    return {
      id: t.id, kind: t.kind, title: t.title, sessionId: t.sessionId, host: t.host,
      username: t.username, port: t.port, status: t.status, startedAt: t.startedAt,
    };
  }

  get(id) {
    const t = this.terms.get(id);
    if (!t) throw new Error(`Terminale ${id} non trovato`);
    return t;
  }

  _new(kind, props) {
    const id = `t${++this.seq}`;
    const t = {
      id, kind, status: 'connecting', buffer: '', listeners: new Set(), startedAt: Date.now(),
      cols: props.cols || 120, rows: props.rows || 32, ...props,
    };
    this.terms.set(id, t);
    return t;
  }

  _setStatus(t, status, message) {
    t.status = status;
    this.emit('status', { id: t.id, status, message, info: this.describe(t) });
  }

  _onData(t, data) {
    const str = typeof data === 'string' ? data : data.toString('utf8');
    t.buffer += str;
    if (t.buffer.length > MAX_BUFFER) t.buffer = t.buffer.slice(-MAX_BUFFER);
    for (const l of t.listeners) l(str);
    this.emit('data', t.id, str);
  }

  // ------------------------------------------------------------------ open

  open(opts) {
    if (opts.kind === 'local') return this.openLocal(opts);
    return this.openSsh(opts);
  }

  openLocal({ cols, rows, cwd, title }) {
    const shell = this.store.settings.localShell ||
      (process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/bash');
    const t = this._new('local', { cols, rows, title: title || `Locale (${path.basename(shell)})`, host: 'localhost',
      username: os.userInfo().username, shell, cwd: expandHome(cwd) || os.homedir() });
    this._spawnLocal(t);
    return this.describe(t);
  }

  _spawnLocal(t) {
    if (!pty) {
      setImmediate(() => this._setStatus(t, 'error', 'node-pty non disponibile: impossibile aprire un terminale locale'));
      return;
    }
    try {
      const p = pty.spawn(t.shell, [], {
        name: 'xterm-256color', cols: t.cols, rows: t.rows, cwd: t.cwd,
        env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
      });
      t.pty = p;
      p.onData((d) => this._onData(t, d));
      p.onExit(({ exitCode }) => { if (t.pty === p) this._setStatus(t, 'closed', `Processo terminato (codice ${exitCode})`); });
      setImmediate(() => this._setStatus(t, 'connected'));
    } catch (e) {
      setImmediate(() => this._setStatus(t, 'error', e.message));
    }
  }

  /**
   * opts: { sessionId } oppure { host, port, username, password } (quick connect)
   * passwordOverride: password fornita al volo dopo un fallimento di autenticazione.
   */
  openSsh(opts) {
    let cfg;
    if (opts.sessionId) {
      cfg = this.store.getSessionSecrets(opts.sessionId);
      if (!cfg) throw new Error('Sessione non trovata');
      this.store.touchSession(opts.sessionId);
    } else {
      cfg = { host: opts.host, port: opts.port || 22, username: opts.username, password: opts.password || '', name: opts.title };
    }
    if (opts.password) cfg.password = opts.password;
    const t = this._new('ssh', {
      cols: opts.cols, rows: opts.rows, sessionId: opts.sessionId || null,
      title: cfg.name || `${cfg.username}@${cfg.host}`, host: cfg.host, port: cfg.port || 22,
      username: cfg.username, startupCommand: cfg.startupCommand,
    });
    setImmediate(() => this._connectSsh(t, cfg));
    return this.describe(t);
  }

  _connectSsh(t, cfg) {
    const conn = new Client();
    t.conn = conn;
    t.sftp = null;
    this._setStatus(t, 'connecting', `Connessione a ${cfg.host}:${cfg.port || 22}...`);

    const options = {
      host: cfg.host,
      port: cfg.port || 22,
      username: cfg.username || os.userInfo().username,
      readyTimeout: 20000,
      keepaliveInterval: 15000,
      keepaliveCountMax: 4,
      tryKeyboard: true,
      hostVerifier: (key, verify) => {
        const fp = fingerprint(key);
        const known = this.store.hostKey(cfg.host, cfg.port || 22);
        if (known === fp) return verify(true);
        if (!known) {
          // Trust-on-first-use, come OpenSSH con StrictHostKeyChecking=accept-new
          this.store.saveHostKey(cfg.host, cfg.port || 22, fp);
          this._onData(t, `\x1b[2m[NovaTerm] Nuova host key per ${cfg.host}: ${fp} (salvata)\x1b[0m\r\n`);
          return verify(true);
        }
        this.hooks.askHostKey({ host: cfg.host, port: cfg.port || 22, known, fingerprint: fp })
          .then((ok) => {
            if (ok) this.store.saveHostKey(cfg.host, cfg.port || 22, fp);
            verify(!!ok);
          })
          .catch(() => verify(false));
      },
    };
    if (cfg.password) options.password = cfg.password;
    if (cfg.privateKeyPath) {
      try {
        options.privateKey = fs.readFileSync(expandHome(cfg.privateKeyPath));
        if (cfg.passphrase) options.passphrase = cfg.passphrase;
      } catch (e) {
        this._onData(t, `\x1b[33m[NovaTerm] Impossibile leggere la chiave ${cfg.privateKeyPath}: ${e.message}\x1b[0m\r\n`);
      }
    }
    if (!cfg.password && !options.privateKey && process.env.SSH_AUTH_SOCK) options.agent = process.env.SSH_AUTH_SOCK;

    conn.on('keyboard-interactive', (_name, _instr, _lang, prompts, finish) => {
      finish(prompts.map(() => cfg.password || ''));
    });

    conn.on('ready', () => {
      conn.shell({ term: 'xterm-256color', cols: t.cols, rows: t.rows }, { env: { COLORTERM: 'truecolor' } }, (err, stream) => {
        if (err) { this._setStatus(t, 'error', err.message); return; }
        t.stream = stream;
        stream.on('data', (d) => this._onData(t, d));
        stream.stderr.on('data', (d) => this._onData(t, d));
        stream.on('close', () => { conn.end(); });
        this._setStatus(t, 'connected', `Connesso a ${cfg.host}`);
        if (t.startupCommand) setTimeout(() => stream.write(t.startupCommand + '\n'), 400);
      });
    });

    conn.on('error', (err) => {
      const authFailed = /authentication methods failed/i.test(err.message);
      this._setStatus(t, authFailed ? 'auth-failed' : 'error', err.message);
    });

    conn.on('close', () => {
      if (t.status === 'connected' || t.status === 'connecting') this._setStatus(t, 'closed', 'Connessione chiusa');
      t.stream = null; t.sftp = null;
    });

    try { conn.connect(options); } catch (e) { this._setStatus(t, 'error', e.message); }
  }

  /** Riconnette un terminale SSH (eventualmente con una nuova password). */
  reconnect(id, { password, savePassword } = {}) {
    const t = this.get(id);
    if (t.kind === 'local') {
      const old = t.pty; t.pty = null;
      try { old?.kill(); } catch {}
      t.buffer += '\r\n';
      this._spawnLocal(t);
      return this.describe(t);
    }
    try { t.conn?.end(); } catch {}
    let cfg;
    if (t.sessionId) {
      if (password && savePassword) this.store.saveSession({ id: t.sessionId, password });
      cfg = this.store.getSessionSecrets(t.sessionId);
    } else {
      cfg = { host: t.host, port: t.port, username: t.username, password: t.password || '' };
    }
    if (password) { cfg.password = password; if (!t.sessionId) t.password = password; }
    t.buffer += '\r\n';
    this._connectSsh(t, cfg);
    return this.describe(t);
  }

  write(id, data) {
    const t = this.terms.get(id);
    if (!t) return;
    if (t.kind === 'local') t.pty?.write(data);
    else t.stream?.write(data);
  }

  resize(id, cols, rows) {
    const t = this.terms.get(id);
    if (!t || !cols || !rows) return;
    t.cols = cols; t.rows = rows;
    try {
      if (t.kind === 'local') t.pty?.resize(cols, rows);
      else t.stream?.setWindow(rows, cols, 0, 0);
    } catch {}
  }

  close(id) {
    const t = this.terms.get(id);
    if (!t) return;
    try { t.kind === 'local' ? t.pty?.kill() : t.conn?.end(); } catch {}
    this.terms.delete(id);
  }

  closeAll() { for (const id of [...this.terms.keys()]) this.close(id); }

  // ------------------------------------------------------------------ Claude helpers

  /** Esegue un comando su un canale separato (non disturba la shell interattiva). */
  exec(id, command, { timeoutSec = 120, maxOutput = 60000 } = {}) {
    const t = this.get(id);
    return new Promise((resolve) => {
      let stdout = '', stderr = '', done = false;
      const started = Date.now();
      const finish = (exitCode, extra) => {
        if (done) return; done = true;
        clearTimeout(timer);
        resolve({
          exitCode, durationMs: Date.now() - started, timedOut: extra === 'timeout',
          stdout: truncate(stripAnsi(stdout), maxOutput), stderr: truncate(stripAnsi(stderr), maxOutput / 2),
          error: extra && extra !== 'timeout' ? extra : undefined,
        });
      };
      let killer = () => {};
      const timer = setTimeout(() => { killer(); finish(null, 'timeout'); }, timeoutSec * 1000);

      if (t.kind === 'local') {
        const isWin = process.platform === 'win32';
        const child = isWin
          ? spawn('powershell.exe', ['-NoProfile', '-Command', command], { cwd: t.cwd })
          : spawn(process.env.SHELL || '/bin/bash', ['-lc', command], { cwd: t.cwd });
        killer = () => { try { child.kill('SIGKILL'); } catch {} };
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('error', (e) => finish(null, e.message));
        child.on('close', (code) => finish(code));
        return;
      }
      if (t.status !== 'connected' || !t.conn) return finish(null, `Terminale ${id} non connesso (stato: ${t.status})`);
      t.conn.exec(command, (err, stream) => {
        if (err) return finish(null, err.message);
        killer = () => { try { stream.signal('KILL'); stream.close(); } catch {} };
        let code = null;
        stream.on('exit', (c) => { code = c; });
        stream.on('data', (d) => { stdout += d; });
        stream.stderr.on('data', (d) => { stderr += d; });
        stream.on('close', (c) => finish(code ?? (typeof c === 'number' ? c : null)));
      });
    });
  }

  /** Scrive nella shell interattiva e cattura l'output finché non torna "quieta". */
  sendAndCapture(id, text, { pressEnter = true, maxWaitMs = 15000, idleMs = 1200 } = {}) {
    const t = this.get(id);
    if (t.status !== 'connected') return Promise.reject(new Error(`Terminale ${id} non connesso (stato: ${t.status})`));
    return new Promise((resolve) => {
      let out = '';
      let idleTimer = null;
      const started = Date.now();
      const done = () => {
        t.listeners.delete(listener);
        clearTimeout(idleTimer); clearTimeout(maxTimer);
        resolve({ output: truncate(stripAnsi(out), 40000), durationMs: Date.now() - started });
      };
      const listener = (d) => { out += d; clearTimeout(idleTimer); idleTimer = setTimeout(done, idleMs); };
      const maxTimer = setTimeout(done, maxWaitMs);
      t.listeners.add(listener);
      idleTimer = setTimeout(done, Math.max(idleMs, 2000));
      this.write(id, text + (pressEnter ? '\r' : ''));
    });
  }

  recentOutput(id, lines = 80) {
    const t = this.get(id);
    const all = stripAnsi(t.buffer).split('\n');
    return all.slice(-lines).join('\n');
  }

  // ------------------------------------------------------------------ SFTP

  _sftp(id) {
    const t = this.get(id);
    if (t.kind !== 'ssh') return Promise.reject(new Error('SFTP disponibile solo per sessioni SSH'));
    if (t.status !== 'connected') return Promise.reject(new Error('Sessione non connessa'));
    if (t.sftp) return Promise.resolve(t.sftp);
    if (t.sftpPending) return t.sftpPending;
    t.sftpPending = new Promise((resolve, reject) => {
      t.conn.sftp((err, sftp) => {
        t.sftpPending = null;
        if (err) return reject(err);
        t.sftp = sftp;
        sftp.on('close', () => { t.sftp = null; });
        resolve(sftp);
      });
    });
    return t.sftpPending;
  }

  async sftpHome(id) {
    const sftp = await this._sftp(id);
    return new Promise((res, rej) => sftp.realpath('.', (e, p) => (e ? rej(e) : res(p))));
  }

  async sftpList(id, dir) {
    const sftp = await this._sftp(id);
    const real = await new Promise((res, rej) => sftp.realpath(dir || '.', (e, p) => (e ? rej(e) : res(p))));
    const list = await new Promise((res, rej) => sftp.readdir(real, (e, l) => (e ? rej(e) : res(l))));
    const entries = list.map((f) => {
      const mode = f.attrs.mode;
      const type = (mode & 0o170000) === 0o040000 ? 'dir' : (mode & 0o170000) === 0o120000 ? 'link' : 'file';
      return { name: f.filename, type, size: f.attrs.size, mtime: f.attrs.mtime * 1000, mode: mode & 0o7777, longname: f.longname };
    });
    // i link a directory: prova a risolverli
    await Promise.all(entries.filter((e) => e.type === 'link').map((e) => new Promise((res) => {
      sftp.stat(path.posix.join(real, e.name), (err, st) => {
        if (!err && (st.mode & 0o170000) === 0o040000) e.linkToDir = true;
        res();
      });
    })));
    entries.sort((a, b) => {
      const ad = a.type === 'dir' || a.linkToDir, bd = b.type === 'dir' || b.linkToDir;
      if (ad !== bd) return ad ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return { path: real, entries };
  }

  async sftpDownload(id, remote, local, onProgress) {
    const sftp = await this._sftp(id);
    return new Promise((res, rej) => sftp.fastGet(remote, local, {
      step: (done, _chunk, total) => onProgress?.(done, total),
    }, (e) => (e ? rej(e) : res(local))));
  }

  async sftpUpload(id, local, remoteDir, onProgress) {
    const sftp = await this._sftp(id);
    const remote = path.posix.join(remoteDir, path.basename(local));
    return new Promise((res, rej) => sftp.fastPut(local, remote, {
      step: (done, _chunk, total) => onProgress?.(done, total),
    }, (e) => (e ? rej(e) : res(remote))));
  }

  async sftpMkdir(id, p) {
    const sftp = await this._sftp(id);
    return new Promise((res, rej) => sftp.mkdir(p, (e) => (e ? rej(e) : res(true))));
  }

  async sftpRename(id, from, to) {
    const sftp = await this._sftp(id);
    return new Promise((res, rej) => sftp.rename(from, to, (e) => (e ? rej(e) : res(true))));
  }

  async sftpDelete(id, p, isDir) {
    const sftp = await this._sftp(id);
    if (!isDir) return new Promise((res, rej) => sftp.unlink(p, (e) => (e ? rej(e) : res(true))));
    // cancellazione ricorsiva
    const rmrf = async (dir) => {
      const list = await new Promise((res, rej) => sftp.readdir(dir, (e, l) => (e ? rej(e) : res(l))));
      for (const f of list) {
        const full = path.posix.join(dir, f.filename);
        if ((f.attrs.mode & 0o170000) === 0o040000) await rmrf(full);
        else await new Promise((res, rej) => sftp.unlink(full, (e) => (e ? rej(e) : res())));
      }
      await new Promise((res, rej) => sftp.rmdir(dir, (e) => (e ? rej(e) : res())));
    };
    await rmrf(p);
    return true;
  }

  async sftpReadFile(id, p, maxBytes = 200000) {
    const sftp = await this._sftp(id);
    return new Promise((res, rej) => {
      const chunks = []; let size = 0;
      const rs = sftp.createReadStream(p, { start: 0, end: maxBytes - 1 });
      rs.on('data', (c) => { chunks.push(c); size += c.length; });
      rs.on('error', rej);
      rs.on('end', () => res({ content: Buffer.concat(chunks).toString('utf8'), truncated: size >= maxBytes }));
    });
  }

  async sftpWriteFile(id, p, content) {
    const sftp = await this._sftp(id);
    return new Promise((res, rej) => sftp.writeFile(p, content, (e) => (e ? rej(e) : res(true))));
  }
}

module.exports = { TerminalManager, stripAnsi };
