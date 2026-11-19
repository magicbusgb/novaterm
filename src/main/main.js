'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme } = require('electron');
const { Store } = require('./store');
const { TerminalManager } = require('./terminals');
const { ClaudeBridge } = require('./claude');
const { parseCsv, exportCsv, TEMPLATE } = require('./csv');

app.setName('NovaTerm');
let win = null;
let store, terms, claude;
let activeTerminal = null;

// ------------------------------------------------------------------ richieste main → renderer con risposta
const pending = new Map();
function rendererRequest(channel, payload, timeoutMs = 0) {
  return new Promise((resolve, reject) => {
    if (!win || win.isDestroyed()) return reject(new Error('Finestra non disponibile'));
    const reqId = crypto.randomUUID();
    let timer = null;
    if (timeoutMs) timer = setTimeout(() => { pending.delete(reqId); reject(new Error('timeout')); }, timeoutMs);
    pending.set(reqId, (result) => { clearTimeout(timer); resolve(result); });
    win.webContents.send(channel, { reqId, ...payload });
  });
}
ipcMain.on('renderer:response', (_e, { reqId, result }) => {
  const cb = pending.get(reqId);
  if (cb) { pending.delete(reqId); cb(result); }
});

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

// ------------------------------------------------------------------ batching dell'output dei terminali
const outBuf = new Map();
let flushTimer = null;
function queueData(id, data) {
  outBuf.set(id, (outBuf.get(id) || '') + data);
  if (!flushTimer) flushTimer = setTimeout(flushData, 6);
}
function flushData() {
  flushTimer = null;
  for (const [id, data] of outBuf) send('term:data', id, data);
  outBuf.clear();
}

// ------------------------------------------------------------------ finestra
function createWindow() {
  const s = store.settings;
  const dark = s.theme !== 'light';
  win = new BrowserWindow({
    width: 1480, height: 920, minWidth: 900, minHeight: 560,
    title: 'NovaTerm',
    backgroundColor: dark ? '#0b0d14' : '#f6f7fb',
    titleBarStyle: 'hidden',
    titleBarOverlay: process.platform === 'darwin' ? true : { color: dark ? '#0b0d14' : '#f6f7fb', symbolColor: dark ? '#c9cdea' : '#30344a', height: 44 },
    trafficLightPosition: { x: 14, y: 14 },
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) { e.preventDefault(); if (/^https?:\/\//.test(url)) shell.openExternal(url); }
  });
  win.on('closed', () => { win = null; });
}

function setupCore() {
  store = new Store();
  nativeTheme.themeSource = store.settings.theme === 'light' ? 'light' : 'dark';

  terms = new TerminalManager(store, {
    askHostKey: (info) => rendererRequest('hostkey:ask', info).then((r) => !!r?.accept),
  });
  terms.on('data', queueData);
  terms.on('status', (ev) => { flushData(); send('term:status', ev); });

  claude = new ClaudeBridge({
    store, terms,
    emit: (ev) => send('claude:event', ev),
    approve: (req) => {
      const { signal, ...payload } = req;
      return new Promise((resolve) => {
        const p = rendererRequest('claude:approval', payload);
        signal?.addEventListener('abort', () => resolve({ allow: false, message: 'Interrotto' }), { once: true });
        p.then(resolve, () => resolve({ allow: false }));
      });
    },
    readScreen: (id, lines) => rendererRequest('term:read-screen', { id, lines }, 3000).then((r) => {
      if (r && typeof r === 'object' && r.error) throw new Error(r.error);
      return r;
    }),
    adoptTerminal: (info) => send('term:adopt', info),
    activeTerminal: () => activeTerminal,
  });
}

// ------------------------------------------------------------------ IPC
function registerIpc() {
  const handle = (ch, fn) => ipcMain.handle(ch, async (_e, ...args) => {
    try { return { ok: true, data: await fn(...args) }; } catch (e) { return { ok: false, error: e?.message || String(e) }; }
  });

  handle('app:init', () => ({
    sessions: store.listSessions(),
    settings: { ...store.getSettings(), claudeApiKey: undefined, hasApiKey: !!store.settings.claudeApiKey },
    terminals: terms.list(),
    platform: process.platform,
    encryption: store.encryptionAvailable(),
    version: app.getVersion(),
    dataDir: store.dir,
  }));

  // sessioni
  handle('sessions:list', () => store.listSessions());
  handle('sessions:save', (s) => store.saveSession(s));
  handle('sessions:delete', (ids) => { store.deleteSessions(ids); return store.listSessions(); });
  handle('sessions:rename-group', (o, n) => { store.renameGroup(o, n); return store.listSessions(); });
  handle('sessions:duplicate', (id) => {
    const s = store.getSessionSecrets(id);
    if (!s) throw new Error('Sessione non trovata');
    const { id: _id, createdAt, lastUsed, ...rest } = s;
    return store.saveSession({ ...rest, name: s.name + ' (copia)' });
  });

  // CSV
  const csvCache = new Map();
  handle('csv:pick', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Importa sessioni da CSV', properties: ['openFile'],
      filters: [{ name: 'CSV', extensions: ['csv', 'txt', 'tsv'] }, { name: 'Tutti i file', extensions: ['*'] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return parseFile(r.filePaths[0]);
  });
  handle('csv:parse-path', (p) => parseFile(p));
  function parseFile(p) {
    const text = fs.readFileSync(p, 'utf8');
    const parsed = parseCsv(text);
    const token = crypto.randomUUID();
    csvCache.set(token, parsed.rows);
    return {
      token, file: path.basename(p), errors: parsed.errors, mapping: parsed.mapping, unknownColumns: parsed.unknownColumns,
      rows: parsed.rows.map((r, i) => ({
        index: i, name: r.name || '', host: r.host || '', port: r.port || '', username: r.username || '', group: r.group || '',
        type: r.type, hasPassword: !!r.password, privateKeyPath: r.privateKeyPath || '',
        duplicate: !!store.findDuplicate(r),
      })),
    };
  }
  handle('csv:import', ({ token, indices, skipDuplicates, group }) => {
    const rows = csvCache.get(token);
    if (!rows) throw new Error('Anteprima scaduta, reimporta il file');
    const chosen = indices.map((i) => rows[i]).filter(Boolean).map((r) => (group && !r.group ? { ...r, group } : r));
    const res = store.importSessions(chosen, { skipDuplicates });
    csvCache.delete(token);
    return { ...res, sessions: store.listSessions() };
  });
  handle('csv:export', async ({ includePasswords, ids }) => {
    const r = await dialog.showSaveDialog(win, { title: 'Esporta sessioni', defaultPath: 'novaterm-sessioni.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] });
    if (r.canceled || !r.filePath) return null;
    const list = (ids?.length ? ids : store.sessions.map((s) => s.id)).map((id) => store.getSessionSecrets(id)).filter(Boolean);
    fs.writeFileSync(r.filePath, exportCsv(list, includePasswords), { mode: 0o600 });
    return r.filePath;
  });
  handle('csv:template', async () => {
    const r = await dialog.showSaveDialog(win, { title: 'Salva modello CSV', defaultPath: 'modello-sessioni.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, TEMPLATE);
    return r.filePath;
  });

  // terminali
  handle('term:open', (opts) => terms.open(opts));
  handle('term:close', (id) => terms.close(id));
  handle('term:reconnect', (id, opts) => terms.reconnect(id, opts));
  handle('term:list', () => terms.list());
  ipcMain.on('term:write', (_e, id, data) => terms.write(id, data));
  ipcMain.on('term:resize', (_e, id, cols, rows) => terms.resize(id, cols, rows));
  ipcMain.on('ui:active-terminal', (_e, id) => { activeTerminal = id; });

  // SFTP
  handle('sftp:list', (id, dir) => terms.sftpList(id, dir));
  handle('sftp:mkdir', (id, p) => terms.sftpMkdir(id, p));
  handle('sftp:rename', (id, a, b) => terms.sftpRename(id, a, b));
  handle('sftp:delete', (id, p, isDir) => terms.sftpDelete(id, p, isDir));
  handle('sftp:download', async (id, remote) => {
    const r = await dialog.showSaveDialog(win, { title: 'Scarica file', defaultPath: path.join(app.getPath('downloads'), path.posix.basename(remote)) });
    if (r.canceled || !r.filePath) return null;
    const tid = crypto.randomUUID();
    await terms.sftpDownload(id, remote, r.filePath, (done, total) => send('sftp:progress', { tid, name: path.posix.basename(remote), done, total, dir: 'down' }));
    send('sftp:progress', { tid, done: 1, total: 1, finished: true });
    return r.filePath;
  });
  handle('sftp:upload', async (id, remoteDir, localPaths) => {
    let files = localPaths;
    if (!files?.length) {
      const r = await dialog.showOpenDialog(win, { title: 'Carica file', properties: ['openFile', 'multiSelections'] });
      if (r.canceled) return [];
      files = r.filePaths;
    }
    const out = [];
    for (const f of files) {
      if (fs.statSync(f).isDirectory()) continue;
      const tid = crypto.randomUUID();
      out.push(await terms.sftpUpload(id, f, remoteDir, (done, total) => send('sftp:progress', { tid, name: path.basename(f), done, total, dir: 'up' })));
      send('sftp:progress', { tid, done: 1, total: 1, finished: true });
    }
    return out;
  });

  // impostazioni
  handle('settings:set', (patch) => {
    const { claudeApiKey, ...rest } = patch;
    const s = store.setSettings(rest);
    if (rest.theme) {
      nativeTheme.themeSource = rest.theme === 'light' ? 'light' : 'dark';
      if (win && process.platform !== 'darwin') {
        const dark = rest.theme !== 'light';
        try { win.setTitleBarOverlay({ color: dark ? '#0b0d14' : '#f6f7fb', symbolColor: dark ? '#c9cdea' : '#30344a' }); } catch {}
      }
    }
    return { ...s, claudeApiKey: undefined, hasApiKey: !!s.claudeApiKey };
  });
  handle('settings:set-api-key', (key) => { store.setSettings({ claudeApiKey: key ? store.encrypt(key) : '' }); return !!key; });
  handle('dialog:pick-file', async (opts = {}) => {
    const r = await dialog.showOpenDialog(win, { title: opts.title || 'Scegli file', defaultPath: opts.defaultPath, properties: ['openFile', 'showHiddenFiles'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('dialog:pick-dir', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('shell:open-path', (p) => shell.showItemInFolder(p));

  // Claude
  handle('claude:ask', (prompt, extra) => { claude.ask(prompt, extra); return true; });
  handle('claude:stop', () => claude.stop());
  handle('claude:reset', () => claude.reset());
  handle('claude:status', () => ({ running: claude.running, sessionId: claude.sessionId }));
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([
    { role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
  ]) : null);
  setupCore();
  registerIpc();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  claude?.stop();
  terms?.closeAll();
  if (process.platform !== 'darwin') app.quit();
});
