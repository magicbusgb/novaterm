'use strict';
/**
 * Persistenza locale: sessioni salvate, impostazioni e host key conosciute.
 * Le password vengono cifrate con safeStorage di Electron (Keychain / DPAPI / libsecret).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, safeStorage } = require('electron');

const DEFAULT_SETTINGS = {
  theme: 'dark',
  accent: 'violet',
  terminalTheme: 'nova',
  fontSize: 14,
  fontFamily: '"JetBrains Mono", "Cascadia Code", "Fira Code", Menlo, Consolas, "DejaVu Sans Mono", monospace',
  cursorStyle: 'bar',
  scrollback: 10000,
  copyOnSelect: true,
  localShell: '',
  claudeModel: 'claude-opus-5-5',
  claudeEffort: 'high',
  claudeAutoApprove: false,
  claudeLocalTools: true,
  claudePath: '',
  claudeWorkdir: '',
  sidebarWidth: 280,
  claudeWidth: 420,
  claudeOpen: true,
};

class Store {
  constructor() {
    this.dir = app.getPath('userData');
    fs.mkdirSync(this.dir, { recursive: true });
    this.sessionsFile = path.join(this.dir, 'sessions.json');
    this.settingsFile = path.join(this.dir, 'settings.json');
    this.knownHostsFile = path.join(this.dir, 'known_hosts.json');
    this.sessions = this._read(this.sessionsFile, []);
    this.settings = { ...DEFAULT_SETTINGS, ...this._read(this.settingsFile, {}) };
    this.knownHosts = this._read(this.knownHostsFile, {});
  }

  _read(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
  }

  _write(file, data) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  // ---------- cifratura ----------
  encryptionAvailable() {
    try { return safeStorage.isEncryptionAvailable(); } catch { return false; }
  }

  encrypt(plain) {
    if (!plain) return '';
    if (this.encryptionAvailable()) return 'enc:' + safeStorage.encryptString(plain).toString('base64');
    return 'b64:' + Buffer.from(plain, 'utf8').toString('base64');
  }

  decrypt(value) {
    if (!value) return '';
    try {
      if (value.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'));
      if (value.startsWith('b64:')) return Buffer.from(value.slice(4), 'base64').toString('utf8');
    } catch (e) {
      console.error('decrypt failed', e);
    }
    return '';
  }

  // ---------- sessioni ----------
  /** Versione sicura da mandare al renderer: niente segreti in chiaro. */
  publicSession(s) {
    const { password, passphrase, ...rest } = s;
    return { ...rest, hasPassword: !!password, hasPassphrase: !!passphrase };
  }

  listSessions() {
    return this.sessions.map((s) => this.publicSession(s));
  }

  getSession(id) {
    return this.sessions.find((s) => s.id === id) || null;
  }

  /** Restituisce la sessione con le credenziali decifrate (solo uso interno al main). */
  getSessionSecrets(id) {
    const s = this.getSession(id);
    if (!s) return null;
    return { ...s, password: this.decrypt(s.password), passphrase: this.decrypt(s.passphrase) };
  }

  normalize(input, existing = {}) {
    const type = (input.type || existing.type || 'ssh').toLowerCase() === 'local' ? 'local' : 'ssh';
    const out = {
      id: existing.id || input.id || crypto.randomUUID(),
      type,
      name: String(input.name ?? existing.name ?? '').trim(),
      host: String(input.host ?? existing.host ?? '').trim(),
      port: parseInt(input.port ?? existing.port ?? 22, 10) || 22,
      username: String(input.username ?? existing.username ?? '').trim(),
      group: String(input.group ?? existing.group ?? '').trim(),
      privateKeyPath: String(input.privateKeyPath ?? existing.privateKeyPath ?? '').trim(),
      notes: String(input.notes ?? existing.notes ?? ''),
      color: input.color ?? existing.color ?? '',
      startupCommand: String(input.startupCommand ?? existing.startupCommand ?? ''),
      password: existing.password || '',
      passphrase: existing.passphrase || '',
      createdAt: existing.createdAt || Date.now(),
      lastUsed: existing.lastUsed || 0,
    };
    // password: undefined = invariata, '' = cancella, stringa = nuova
    if (input.password !== undefined && input.password !== null) out.password = this.encrypt(String(input.password));
    if (input.passphrase !== undefined && input.passphrase !== null) out.passphrase = this.encrypt(String(input.passphrase));
    if (!out.name) out.name = type === 'local' ? 'Terminale locale' : (out.username ? `${out.username}@${out.host}` : out.host);
    return out;
  }

  saveSession(input) {
    const idx = input.id ? this.sessions.findIndex((s) => s.id === input.id) : -1;
    const s = this.normalize(input, idx >= 0 ? this.sessions[idx] : {});
    if (idx >= 0) this.sessions[idx] = s; else this.sessions.push(s);
    this._write(this.sessionsFile, this.sessions);
    return this.publicSession(s);
  }

  importSessions(list, { skipDuplicates = true } = {}) {
    let added = 0, updated = 0, skipped = 0;
    for (const item of list) {
      const dup = this.findDuplicate(item);
      if (dup) {
        if (skipDuplicates) { skipped++; continue; }
        Object.assign(dup, this.normalize(item, dup));
        updated++;
      } else {
        this.sessions.push(this.normalize(item));
        added++;
      }
    }
    this._write(this.sessionsFile, this.sessions);
    return { added, updated, skipped };
  }

  /** Duplicato = stesso host, porta, utente e nome (lo stesso server può avere più sessioni con nomi diversi). */
  findDuplicate(item) {
    const port = parseInt(item.port, 10) || 22;
    const name = (item.name || '').trim().toLowerCase();
    return this.sessions.find((s) => s.type === (item.type || 'ssh') && s.host === (item.host || '') && (s.port || 22) === port &&
      s.username === (item.username || '') && (!name || s.name.toLowerCase() === name)) || null;
  }

  deleteSessions(ids) {
    const set = new Set(ids);
    this.sessions = this.sessions.filter((s) => !set.has(s.id));
    this._write(this.sessionsFile, this.sessions);
  }

  touchSession(id) {
    const s = this.getSession(id);
    if (s) { s.lastUsed = Date.now(); this._write(this.sessionsFile, this.sessions); }
  }

  renameGroup(oldName, newName) {
    for (const s of this.sessions) if (s.group === oldName) s.group = newName;
    this._write(this.sessionsFile, this.sessions);
  }

  // ---------- impostazioni ----------
  getSettings() { return { ...this.settings }; }

  setSettings(patch) {
    this.settings = { ...this.settings, ...patch };
    this._write(this.settingsFile, this.settings);
    return this.getSettings();
  }

  // ---------- known hosts ----------
  hostKey(host, port) { return this.knownHosts[`${host}:${port}`] || null; }

  saveHostKey(host, port, fingerprint) {
    this.knownHosts[`${host}:${port}`] = fingerprint;
    this._write(this.knownHostsFile, this.knownHosts);
  }
}

module.exports = { Store, DEFAULT_SETTINGS };
