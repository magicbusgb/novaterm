'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = async (channel, ...args) => {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.data;
};

const on = (channel, fn) => {
  const h = (_e, ...args) => fn(...args);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

/** Richiesta dal main che si aspetta una risposta (approvazioni, host key, lettura schermo). */
const onRequest = (channel, fn) => on(channel, async (payload) => {
  const { reqId, ...rest } = payload;
  let result;
  try { result = await fn(rest); } catch (e) { result = { error: e.message }; }
  ipcRenderer.send('renderer:response', { reqId, result });
});

contextBridge.exposeInMainWorld('nova', {
  invoke,
  on,
  onRequest,
  write: (id, data) => ipcRenderer.send('term:write', id, data),
  resize: (id, cols, rows) => ipcRenderer.send('term:resize', id, cols, rows),
  setActiveTerminal: (id) => ipcRenderer.send('ui:active-terminal', id),
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return ''; } },
  platform: process.platform,
});
