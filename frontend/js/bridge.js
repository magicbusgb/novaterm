/* Ponte tra interfaccia e backend Go: Wails (app desktop) oppure WebSocket (modalità di test). */
(function () {
  const listeners = new Map(); // nome evento -> Set(fn)
  const requestHandlers = new Map(); // canale -> fn
  const emitLocal = (name, args) => (listeners.get(name) || []).forEach((fn) => { try { fn(...args); } catch (e) { console.error(e); } });

  let call, sendWrite, sendResize, sendActive, sendRespond;

  const isWails = !!(window.wailsbindings || window.runtime || window.go || (window.chrome && window.chrome.webview) || (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.external));
  if (isWails) {
    // il runtime Wails può completarsi dopo il caricamento degli script: attendi
    const ready = new Promise((resolve) => {
      const t0 = Date.now();
      const check = () => (window.go && window.go.main && window.go.main.App && window.runtime ? resolve() : Date.now() - t0 > 10000 ? resolve() : setTimeout(check, 15));
      check();
    });
    const W = () => window.go.main.App;
    call = async (channel, args) => { await ready; return W().Invoke(channel, args); };
    sendWrite = (id, data) => ready.then(() => W().Write(id, data));
    sendResize = (id, c, r) => ready.then(() => W().Resize(id, c, r));
    sendActive = (id) => ready.then(() => W().SetActive(id || ''));
    sendRespond = (reqId, result) => ready.then(() => W().Respond(reqId, result === undefined ? null : result));
    ready.then(() => ['term:data', 'term:status', 'term:adopt', 'claude:event', 'sftp:progress', 'rpc:request', 'file:drop']
      .forEach((name) => window.runtime.EventsOn(name, (...args) => emitLocal(name, args))));
  } else {
    const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    const queue = [];
    const pending = new Map();
    let seq = 0;
    const send = (m) => (ws.readyState === 1 ? ws.send(JSON.stringify(m)) : queue.push(m));
    ws.onopen = () => { while (queue.length) ws.send(JSON.stringify(queue.shift())); };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.t === 'res') { const p = pending.get(m.id); pending.delete(m.id); if (p) (m.ok ? p.resolve(m.data) : p.reject(new Error(m.error))); }
      if (m.t === 'event') emitLocal(m.name, m.args || []);
    };
    call = (channel, args) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); send({ t: 'invoke', id, channel, args }); });
    sendWrite = (term, data) => send({ t: 'write', term, data });
    sendResize = (term, cols, rows) => send({ t: 'resize', term, cols, rows });
    sendActive = (term) => send({ t: 'active', term: term || '' });
    sendRespond = (reqId, result) => send({ t: 'respond', reqId, result: result === undefined ? null : result });
  }

  // richieste dal backend che aspettano una risposta
  (listeners.get('rpc:request') || listeners.set('rpc:request', new Set()).get('rpc:request')).add(async ({ reqId, channel, payload }) => {
    const fn = requestHandlers.get(channel);
    let result;
    try { result = fn ? await fn(payload || {}) : { error: 'nessun gestore' }; } catch (e) { result = { error: e.message }; }
    sendRespond(reqId, result);
  });

  const ua = navigator.userAgent;
  window.nova = {
    platform: /Windows/.test(ua) ? 'win32' : /Mac/.test(ua) ? 'darwin' : 'linux',
    invoke: async (channel, ...args) => {
      try { return await call(channel, args); } catch (e) { throw e instanceof Error ? e : new Error(String(e)); }
    },
    on: (name, fn) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
      return () => listeners.get(name).delete(fn);
    },
    onRequest: (channel, fn) => { requestHandlers.set(channel, fn); },
    write: (id, data) => sendWrite(id, data),
    resize: (id, cols, rows) => sendResize(id, cols, rows),
    setActiveTerminal: (id) => sendActive(id),
    openExternal: (url) => call('shell:open-url', [url]),
    clipboard: {
      writeText: (t) => call('clipboard:set', [String(t ?? '')]),
      readText: async () => (await call('clipboard:get', [])) || '',
    },
  };

  // file trascinati sulla finestra: Wails fornisce i percorsi completi
  window.nova.on('file:drop', ({ x, y, paths }) => {
    const target = document.elementFromPoint(x, y) || document.body;
    target.dispatchEvent(new CustomEvent('nova-file-drop', { bubbles: true, detail: { paths } }));
  });

  // link esterni nel browser di sistema
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (a && /^https?:\/\//.test(a.getAttribute('href'))) { e.preventDefault(); window.nova.openExternal(a.href); }
  });
})();
