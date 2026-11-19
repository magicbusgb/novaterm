/* Schede terminale (xterm.js) */
(function () {
  const { $, $$, esc, html, icon, contextMenu, toast } = window.UI;
  const App = (window.App = window.App || {});

  const STATUS_LABEL = { connecting: 'Connessione…', connected: 'Connesso', closed: 'Disconnesso', error: 'Errore', 'auth-failed': 'Autenticazione fallita' };

  const Terms = {
    tabs: new Map(),
    order: [],
    activeId: null,
    multi: false,

    active() { return this.tabs.get(this.activeId) || null; },
    openSessionIds() { return [...this.tabs.values()].map((t) => t.info.sessionId).filter(Boolean); },

    xtermOptions() {
      const s = App.settings;
      const theme = window.TermThemes[s.terminalTheme] || window.TermThemes.nova;
      return {
        fontFamily: s.fontFamily, fontSize: s.fontSize, lineHeight: 1.18, letterSpacing: 0,
        cursorBlink: true, cursorStyle: s.cursorStyle || 'bar', scrollback: s.scrollback || 10000,
        allowProposedApi: true, macOptionIsMeta: true, rightClickSelectsWord: false, drawBoldTextInBrightColors: true,
        theme, minimumContrastRatio: 1,
      };
    },

    applySettings() {
      const opts = this.xtermOptions();
      document.documentElement.style.setProperty('--term-bg', opts.theme.background);
      for (const t of this.tabs.values()) {
        for (const [k, v] of Object.entries(opts)) {
          if (k === 'theme' || t.term.options[k] !== v) { try { t.term.options[k] = v; } catch (e) { console.warn('xterm option', k, e); } }
        }
        try { t.term.refresh(0, t.term.rows - 1); } catch {}
        this.fit(t);
      }
    },

    // ---------------------------------------------------------- apertura
    async openSession(sessionId) {
      const s = App.Sessions.get(sessionId);
      if (s?.type === 'local') return this.openLocal(s.name);
      const tab = this.createTab({ title: s?.name || 'SSH', kind: 'ssh', sessionId, color: s?.color });
      try {
        const info = await nova.invoke('term:open', { kind: 'ssh', sessionId, cols: tab.term.cols, rows: tab.term.rows });
        this.bind(tab, info);
        App.Sessions.render();
      } catch (e) { this.setOverlay(tab, 'error', e.message); }
    },

    async openLocal(title) {
      const tab = this.createTab({ title: title || 'Locale', kind: 'local' });
      try {
        const info = await nova.invoke('term:open', { kind: 'local', cols: tab.term.cols, rows: tab.term.rows, title });
        this.bind(tab, info);
      } catch (e) { this.setOverlay(tab, 'error', e.message); }
    },

    async quickConnect({ host, port, username, password }) {
      const tab = this.createTab({ title: `${username ? username + '@' : ''}${host}`, kind: 'ssh' });
      try {
        const info = await nova.invoke('term:open', { kind: 'ssh', host, port, username, password, title: tab.title, cols: tab.term.cols, rows: tab.term.rows });
        this.bind(tab, info);
      } catch (e) { this.setOverlay(tab, 'error', e.message); }
    },

    /** Terminale creato dal main (es. da Claude con open_session). */
    adopt(info) {
      if (this.tabs.has(info.id)) return;
      const s = info.sessionId ? App.Sessions.get(info.sessionId) : null;
      const tab = this.createTab({ title: info.title, kind: info.kind, sessionId: info.sessionId, color: s?.color }, { activate: false });
      this.bind(tab, info);
      this.fit(tab);
      App.Sessions.render();
    },

    // ---------------------------------------------------------- creazione scheda
    createTab(meta, { activate = true } = {}) {
      const tmpId = 'pending-' + Math.random().toString(36).slice(2);
      const pane = html(`<div class="term-pane"></div>`);
      $('#term-host').appendChild(pane);
      const term = new Terminal(this.xtermOptions());
      const fit = new FitAddon.FitAddon();
      const search = new SearchAddon.SearchAddon();
      term.loadAddon(fit);
      term.loadAddon(search);
      term.loadAddon(new WebLinksAddon.WebLinksAddon((ev, uri) => { if (ev.ctrlKey || ev.metaKey) window.open(uri); }));

      const tab = { id: tmpId, info: { ...meta, status: 'connecting' }, title: meta.title, term, fit, search, pane, broadcast: true, sftpPath: null, gotData: false };
      const tabEl = html(`<div class="tab" draggable="true">
          <input type="checkbox" class="t-bcast" checked title="Includi nella multi-esecuzione" />
          <span class="status-dot connecting"></span>
          <span class="t-title"></span>
          <button class="t-close" title="Chiudi (Ctrl+Shift+W)">${icon('x')}</button>
        </div>`);
      $('.t-title', tabEl).textContent = meta.title;
      if (meta.color) tabEl.style.setProperty('--tab-color', meta.color);
      tab.tabEl = tabEl;
      $('#tabs').appendChild(tabEl);

      tabEl.addEventListener('mousedown', (e) => {
        if (e.button === 1) { e.preventDefault(); this.close(tab.id); }
      });
      tabEl.addEventListener('click', (e) => {
        if (e.target.closest('.t-close')) return this.close(tab.id);
        if (e.target.closest('.t-bcast')) { tab.broadcast = e.target.checked; this.updateMultiBanner(); return; }
        this.activate(tab.id);
      });
      tabEl.addEventListener('dblclick', (e) => { if (!e.target.closest('button,input')) this.rename(tab); });
      tabEl.addEventListener('contextmenu', (e) => { e.preventDefault(); this.tabMenu(tab, e.clientX, e.clientY); });
      tabEl.addEventListener('dragstart', (e) => { e.dataTransfer.setData('nova/tab', tab.id); });
      tabEl.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('nova/tab')) e.preventDefault(); });
      tabEl.addEventListener('drop', (e) => {
        const from = e.dataTransfer.getData('nova/tab');
        if (!from || from === tab.id) return;
        const fromEl = this.tabs.get(from)?.tabEl;
        if (fromEl) { $('#tabs').insertBefore(fromEl, tabEl); this.order = $$('#tabs .tab').map((el) => [...this.tabs.values()].find((t) => t.tabEl === el)?.id); }
      });

      term.open(pane);
      this.tabs.set(tmpId, tab);
      this.order.push(tmpId);

      term.onData((data) => this.input(tab, data));
      term.onBinary((data) => this.input(tab, data));
      term.onResize(({ cols, rows }) => { if (!tab.id.startsWith('pending-')) nova.resize(tab.id, cols, rows); });
      term.onSelectionChange(() => {
        if (App.settings.copyOnSelect && term.hasSelection()) navigator.clipboard.writeText(term.getSelection()).catch(() => {});
      });
      term.attachCustomKeyEventHandler((e) => this.keyHandler(tab, e));
      pane.addEventListener('contextmenu', (e) => { e.preventDefault(); this.termMenu(tab, e.clientX, e.clientY); });
      pane.addEventListener('auxclick', (e) => {
        if (e.button === 1) { e.preventDefault(); navigator.clipboard.readText().then((t) => t && term.paste(t)); }
      });

      if (activate) this.activate(tmpId); else { pane.classList.add('active'); this.fit(tab); pane.classList.remove('active'); }
      this.fit(tab);
      this.setOverlay(tab, 'connecting', meta.kind === 'local' ? 'Avvio della shell…' : 'Connessione in corso…');
      return tab;
    },

    bind(tab, info) {
      const oldId = tab.id;
      this.tabs.delete(oldId);
      tab.id = info.id;
      tab.info = { ...tab.info, ...info };
      this.tabs.set(info.id, tab);
      this.order = this.order.map((x) => (x === oldId ? info.id : x));
      if (this.activeId === oldId) { this.activeId = info.id; nova.setActiveTerminal(info.id); }
      tab.tabEl.dataset.id = info.id;
      tab.tabEl.title = info.kind === 'ssh' ? `${info.username}@${info.host}:${info.port}  [${info.id}]` : `${info.title}  [${info.id}]`;
      // eventuali dati/stati arrivati prima del bind
      const early = this.early.get(info.id);
      if (early) { early.forEach((fn) => fn()); this.early.delete(info.id); }
      nova.resize(info.id, tab.term.cols, tab.term.rows);
      if (tab === this.active()) App.Claude?.renderContext();
      this.updateStatus(tab, tab.info.status === 'connecting' ? null : tab.info.status);
    },
    early: new Map(),

    // ---------------------------------------------------------- I/O
    input(tab, data) {
      if (tab.id.startsWith('pending-')) return;
      if (this.multi && tab.broadcast) {
        for (const t of this.tabs.values()) if (t.broadcast && t.info.status === 'connected') nova.write(t.id, data);
      } else {
        nova.write(tab.id, data);
      }
      if (tab.info.status !== 'connected' && (data === 'r' || data === 'R' || data === '\r') && ['closed', 'error'].includes(tab.info.status)) this.reconnect(tab);
    },

    onData(id, data) {
      const tab = this.tabs.get(id);
      if (!tab) { const q = this.early.get(id) || []; q.push(() => this.onData(id, data)); this.early.set(id, q); return; }
      tab.term.write(data);
      if (!tab.gotData) { tab.gotData = true; if (tab.info.status === 'connected') this.setOverlay(tab, null); }
    },

    onStatus(ev) {
      const tab = this.tabs.get(ev.id);
      if (!tab) { const q = this.early.get(ev.id) || []; q.push(() => this.onStatus(ev)); this.early.set(ev.id, q); return; }
      tab.info = { ...tab.info, ...ev.info, status: ev.status };
      this.updateStatus(tab, ev.status, ev.message);
    },

    updateStatus(tab, status, message) {
      status = status || tab.info.status;
      const dot = $('.status-dot', tab.tabEl);
      dot.className = 'status-dot ' + status;
      if (status === 'connected') {
        this.setOverlay(tab, null);
        if (tab === this.active()) { tab.term.focus(); App.Sftp?.onActiveChanged(); }
      } else if (status === 'connecting') {
        this.setOverlay(tab, 'connecting', message);
      } else {
        this.setOverlay(tab, status, message);
        if (status !== 'auth-failed') tab.term.write(`\r\n\x1b[2m[${STATUS_LABEL[status]}${message ? ': ' + message : ''}]\x1b[0m\r\n`);
      }
      App.updateStatusbar();
      App.Sessions.render();
      if (tab === this.active()) App.Sftp?.onActiveChanged();
    },

    setOverlay(tab, kind, message = '') {
      tab.overlay?.remove();
      tab.overlay = null;
      if (!kind) return;
      let content;
      if (kind === 'connecting') {
        content = `<div class="overlay-card"><div class="spinner"></div><h4>${esc(tab.title)}</h4><p>${esc(message || 'Connessione in corso…')}</p>
          <div class="row"><button class="btn ghost sm" data-act="close">Annulla</button></div></div>`;
      } else if (kind === 'auth-failed') {
        const canSave = !!tab.info.sessionId;
        content = `<div class="overlay-card"><div class="big-icon">${icon('lock')}</div><h4>Autenticazione richiesta</h4>
          <p>${esc(tab.info.username || '')}@${esc(tab.info.host || '')} ha rifiutato le credenziali.</p>
          <form><input class="input" type="password" placeholder="Password" autocomplete="off" />
          ${canSave ? `<label class="check"><input type="checkbox" checked data-save /> Salva la password nella sessione</label>` : ''}
          <div class="row"><button type="button" class="btn ghost" data-act="close">Chiudi scheda</button><button class="btn primary" type="submit">${icon('plug')} Connetti</button></div></form></div>`;
      } else {
        content = `<div class="overlay-card"><div class="big-icon ${kind === 'error' ? 'err' : ''}">${icon(kind === 'error' ? 'alertCircle' : 'unplug')}</div>
          <h4>${kind === 'error' ? 'Connessione non riuscita' : 'Sessione terminata'}</h4><p>${esc(message || '')}</p>
          <div class="row"><button class="btn ghost" data-act="close">Chiudi scheda</button><button class="btn primary" data-act="reconnect">${icon('refresh')} Riconnetti</button></div></div>`;
      }
      const ov = html(`<div class="term-overlay">${content}</div>`);
      ov.addEventListener('click', (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'close') this.close(tab.id);
        if (act === 'reconnect') this.reconnect(tab);
      });
      const form = $('form', ov);
      if (form) form.addEventListener('submit', (e) => {
        e.preventDefault();
        const pw = $('input[type=password]', form).value;
        this.reconnect(tab, { password: pw, savePassword: !!$('[data-save]', form)?.checked });
      });
      tab.pane.appendChild(ov);
      tab.overlay = ov;
      if (form && tab === this.active()) setTimeout(() => $('input', form).focus(), 30);
    },

    async reconnect(tab, opts = {}) {
      if (tab.id.startsWith('pending-')) return;
      tab.gotData = false;
      this.setOverlay(tab, 'connecting', 'Riconnessione…');
      try { await nova.invoke('term:reconnect', tab.id, opts); } catch (e) { this.setOverlay(tab, 'error', e.message); }
      if (opts.savePassword) App.Sessions.set(await nova.invoke('sessions:list'));
    },

    // ---------------------------------------------------------- gestione schede
    activate(id) {
      const tab = this.tabs.get(id);
      if (!tab) return;
      this.activeId = id;
      for (const t of this.tabs.values()) {
        t.pane.classList.toggle('active', t === tab);
        t.tabEl.classList.toggle('active', t === tab);
      }
      tab.tabEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      if (!id.startsWith('pending-')) nova.setActiveTerminal(id);
      requestAnimationFrame(() => { this.fit(tab); if (!tab.overlay) tab.term.focus(); });
      App.Welcome.toggle(false);
      App.updateStatusbar();
      App.Sftp?.onActiveChanged();
      App.Claude?.renderContext();
    },

    close(id) {
      const tab = this.tabs.get(id);
      if (!tab) return;
      if (!id.startsWith('pending-')) nova.invoke('term:close', id);
      tab.term.dispose();
      tab.pane.remove();
      tab.tabEl.remove();
      this.tabs.delete(id);
      const idx = this.order.indexOf(id);
      this.order.splice(idx, 1);
      if (this.activeId === id) {
        const next = this.order[Math.min(idx, this.order.length - 1)];
        this.activeId = null;
        nova.setActiveTerminal(null);
        if (next) this.activate(next);
      }
      if (!this.tabs.size) { App.Welcome.toggle(true); App.updateStatusbar(); App.Sftp?.onActiveChanged(); App.Claude?.renderContext(); }
      App.Sessions.render();
      this.updateMultiBanner();
    },

    cycle(dir) {
      if (!this.order.length) return;
      const i = this.order.indexOf(this.activeId);
      this.activate(this.order[(i + dir + this.order.length) % this.order.length]);
    },

    async rename(tab) {
      const n = await UI.promptDialog({ title: 'Rinomina scheda', label: 'Titolo', value: tab.title });
      if (n) { tab.title = n; $('.t-title', tab.tabEl).textContent = n; }
    },

    duplicate(tab) {
      if (tab.info.sessionId) this.openSession(tab.info.sessionId);
      else if (tab.info.kind === 'local') this.openLocal();
      else toast('Le connessioni rapide non possono essere duplicate: salvale come sessione', 'warn');
    },

    fit(tab) {
      if (!tab || !tab.pane.classList.contains('active')) return;
      try { tab.fit.fit(); } catch {}
    },

    fitActive() { this.fit(this.active()); },

    setMulti(on) {
      this.multi = on;
      document.querySelector('.workspace').classList.toggle('multi', on);
      $('#btn-multi').classList.toggle('on', on);
      this.updateMultiBanner();
      if (on) toast('Multi-esecuzione attiva: ciò che digiti va a tutte le schede selezionate', 'warn');
    },

    updateMultiBanner() {
      const n = [...this.tabs.values()].filter((t) => t.broadcast).length;
      $('#multi-banner').classList.toggle('hidden', !this.multi);
      $('#multi-banner-text').textContent = `Multi-esecuzione attiva — la digitazione viene inviata a ${n} terminal${n === 1 ? 'e' : 'i'}`;
      requestAnimationFrame(() => this.fitActive());
    },

    markClaudeActivity(id) {
      const tab = this.tabs.get(id);
      if (!tab) return;
      tab.tabEl.classList.add('claude-busy');
      clearTimeout(tab.claudeTimer);
      tab.claudeTimer = setTimeout(() => tab.tabEl.classList.remove('claude-busy'), 4000);
    },

    /** Testo dello schermo per lo strumento read_terminal di Claude. */
    readScreen(id, lines = 60) {
      const tab = this.tabs.get(id);
      if (!tab) throw new Error('terminale non trovato');
      const buf = tab.term.buffer.active;
      let end = buf.baseY + tab.term.rows;
      while (end > 0 && !(buf.getLine(end - 1)?.translateToString(true) ?? '').trim()) end--;
      const start = Math.max(0, end - lines);
      const out = [];
      for (let i = start; i < end; i++) out.push(buf.getLine(i)?.translateToString(true) ?? '');
      return out.join('\n');
    },

    // ---------------------------------------------------------- tastiera / menu
    keyHandler(tab, e) {
      if (e.type !== 'keydown') return true;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && e.shiftKey && k === 'c') { if (tab.term.hasSelection()) navigator.clipboard.writeText(tab.term.getSelection()); return false; }
      if (mod && e.shiftKey && k === 'v') { navigator.clipboard.readText().then((t) => t && tab.term.paste(t)); return false; }
      if (e.metaKey && k === 'c' && tab.term.hasSelection()) { navigator.clipboard.writeText(tab.term.getSelection()); return false; }
      if (e.metaKey && k === 'v') { navigator.clipboard.readText().then((t) => t && tab.term.paste(t)); return false; }
      if (mod && e.shiftKey && k === 'f') { this.openSearch(tab); return false; }
      if (mod && e.shiftKey && ['t', 'w', 'k', 'n', 'l'].includes(k)) return false; // gestite globalmente
      if (e.ctrlKey && k === 'tab') return false;
      if (mod && !e.shiftKey && k === 'k' && !e.altKey) return false;
      if (mod && (k === '=' || k === '+' || k === '-' || k === '0') && !e.shiftKey) return false;
      return true;
    },

    termMenu(tab, x, y) {
      const sel = tab.term.getSelection();
      contextMenu(x, y, [
        { text: 'Copia', icon: 'copy', kbd: 'Ctrl+Shift+C', disabled: !sel, action: () => navigator.clipboard.writeText(sel) },
        { text: 'Incolla', icon: 'clipboard', kbd: 'Ctrl+Shift+V', action: () => navigator.clipboard.readText().then((t) => t && tab.term.paste(t)) },
        { text: 'Seleziona tutto', icon: 'layers', action: () => tab.term.selectAll() },
        { text: 'Cerca…', icon: 'search', kbd: 'Ctrl+Shift+F', action: () => this.openSearch(tab) },
        { text: 'Pulisci schermo', icon: 'refresh', action: () => tab.term.clear() },
        '-',
        sel && { text: 'Chiedi a Claude sulla selezione', icon: 'sparkles', action: () => App.Claude.attachSelection(sel, tab.id) },
        { text: 'Spiega l\'output con Claude', icon: 'sparkles', action: () => App.Claude.quickAsk('Guarda lo schermo del terminale attivo con read_terminal e spiegami cosa sta succedendo. Se vedi errori, proponi come risolverli.') },
        '-',
        { text: 'Riconnetti', icon: 'refresh', action: () => this.reconnect(tab) },
        { text: 'Duplica scheda', icon: 'copy', action: () => this.duplicate(tab) },
        { text: 'Chiudi', icon: 'x', danger: true, action: () => this.close(tab.id) },
      ]);
    },

    tabMenu(tab, x, y) {
      contextMenu(x, y, [
        { text: 'Rinomina…', icon: 'edit', action: () => this.rename(tab) },
        { text: 'Duplica', icon: 'copy', action: () => this.duplicate(tab) },
        { text: 'Riconnetti', icon: 'refresh', action: () => this.reconnect(tab) },
        tab.info.sessionId && { text: 'Modifica sessione…', icon: 'settings', action: () => App.Dialogs.sessionEditor(App.Sessions.get(tab.info.sessionId)) },
        '-',
        { text: 'Chiudi le altre', icon: 'x', action: () => [...this.tabs.keys()].filter((i) => i !== tab.id).forEach((i) => this.close(i)) },
        { text: 'Chiudi', icon: 'x', danger: true, action: () => this.close(tab.id) },
      ]);
    },

    openSearch(tab) {
      let bar = $('.term-search', tab.pane);
      if (!bar) {
        bar = html(`<div class="term-search">${icon('search')}<input placeholder="Cerca nel terminale" /><span class="count"></span>
          <button class="icon-btn" data-dir="prev" title="Precedente">${icon('arrowUp')}</button>
          <button class="icon-btn" data-dir="next" title="Successivo"><span style="transform:rotate(180deg);display:grid">${icon('arrowUp')}</span></button>
          <button class="icon-btn" data-dir="close">${icon('x')}</button></div>`);
        tab.pane.appendChild(bar);
        const input = $('input', bar);
        const opts = { decorations: { matchBackground: '#ffd16655', activeMatchBackground: '#ffd166', matchOverviewRuler: '#ffd166', activeMatchColorOverviewRuler: '#ff9f1c' } };
        tab.search.onDidChangeResults?.(({ resultIndex, resultCount }) => { $('.count', bar).textContent = resultCount ? `${resultIndex + 1}/${resultCount}` : '0'; });
        const go = (prev) => (prev ? tab.search.findPrevious(input.value, opts) : tab.search.findNext(input.value, opts));
        input.addEventListener('input', () => go(false));
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') go(e.shiftKey);
          if (e.key === 'Escape') { tab.search.clearDecorations(); bar.remove(); tab.term.focus(); }
        });
        bar.addEventListener('click', (e) => {
          const d = e.target.closest('[data-dir]')?.dataset.dir;
          if (d === 'close') { tab.search.clearDecorations(); bar.remove(); tab.term.focus(); }
          else if (d) go(d === 'prev');
        });
      }
      const input = $('input', bar);
      const sel = tab.term.getSelection();
      if (sel && !sel.includes('\n')) input.value = sel;
      input.focus(); input.select();
    },

    init() {
      nova.on('term:data', (id, data) => this.onData(id, data));
      nova.on('term:status', (ev) => this.onStatus(ev));
      nova.on('term:adopt', (info) => this.adopt(info));
      nova.onRequest('term:read-screen', ({ id, lines }) => this.readScreen(id, lines));
      new ResizeObserver(() => this.fitActive()).observe($('#term-host'));
    },
  };

  App.Terms = Terms;
})();
