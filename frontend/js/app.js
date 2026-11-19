/* Bootstrap dell'applicazione */
(function () {
  const { $, $$, esc, html, icon, contextMenu, toast } = window.UI;
  const App = (window.App = window.App || {});

  // ------------------------------------------------------------ impostazioni
  App.applySettings = function () {
    const s = App.settings;
    document.documentElement.dataset.theme = s.theme === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.accent = s.accent || 'violet';
    document.documentElement.style.setProperty('--sidebar-w', (s.sidebarWidth || 280) + 'px');
    document.documentElement.style.setProperty('--claude-w', (s.claudeWidth || 420) + 'px');
    App.Terms.applySettings();
  };

  App.saveSettings = async function (patch) {
    // se il tema dell'interfaccia cambia, allinea il tema del terminale se era quello predefinito dell'altro tema
    if (patch.theme && !patch.terminalTheme) {
      if (patch.theme === 'light' && App.settings.terminalTheme !== 'paper') patch.terminalTheme = 'paper';
      if (patch.theme === 'dark' && App.settings.terminalTheme === 'paper') patch.terminalTheme = 'nova';
    }
    App.settings = { ...App.settings, ...(await nova.invoke('settings:set', patch)) };
    App.applySettings();
    return App.settings;
  };

  App.setClaudeOpen = function (open) {
    $('#claude-panel').classList.toggle('collapsed', !open);
    $('.main').classList.toggle('no-claude', !open);
    $('#btn-claude').classList.toggle('on', open);
    if (open !== App.settings.claudeOpen) nova.invoke('settings:set', { claudeOpen: open }).then((s) => { App.settings.claudeOpen = s.claudeOpen; });
    requestAnimationFrame(() => App.Terms.fitActive());
  };

  // ------------------------------------------------------------ status bar
  App.updateStatusbar = function () {
    const t = App.Terms.active();
    const left = $('#sb-left');
    if (t) {
      const i = t.info;
      left.innerHTML = `<span class="sb-item"><span class="status-dot ${i.status}"></span>${esc({ connecting: 'Connessione…', connected: 'Connesso', closed: 'Disconnesso', error: 'Errore', 'auth-failed': 'Auth fallita' }[i.status] || '')}</span>
        <span class="sb-item mono">${icon(i.kind === 'ssh' ? 'server' : 'terminal')}${esc(i.kind === 'ssh' ? `${i.username || ''}@${i.host}:${i.port}` : i.title || 'locale')}</span>
        <span class="sb-item mono">${t.term.cols}×${t.term.rows}</span>
        ${i.id && !i.id.startsWith('pending') ? `<span class="sb-item mono" title="Id usato da Claude">${esc(i.id)}</span>` : ''}`;
    } else {
      left.innerHTML = `<span class="sb-item">${icon('info')}Nessuna sessione attiva</span>`;
    }
    const n = App.Terms.tabs.size;
    $('#sb-right').innerHTML = `
      <span class="sb-item">${icon('layers')}${n} schede</span>
      <span class="sb-item ${App.Claude?.running ? 'accent' : ''}">${icon('sparkles')}Claude ${App.Claude?.running ? 'al lavoro…' : 'pronto'}</span>
      <span class="sb-item" title="${App.encryption ? 'Credenziali cifrate con il portachiavi di sistema' : 'Portachiavi non disponibile'}">${icon(App.encryption ? 'lock' : 'unlock')}${App.encryption ? 'Cifrato' : 'Non cifrato'}</span>`;
  };

  // ------------------------------------------------------------ welcome
  App.Welcome = {
    toggle(show) { $('#welcome').classList.toggle('show', show); if (show) this.render(); },
    render() {
      if (!$('#welcome').classList.contains('show')) return;
      const recent = [...App.Sessions.list].filter((s) => s.lastUsed).sort((a, b) => b.lastUsed - a.lastUsed).slice(0, 6);
      const fallback = recent.length ? recent : App.Sessions.list.slice(0, 6);
      $('#welcome').innerHTML = `<div class="welcome-inner">
        <div class="hero">${$('.brand .logo').outerHTML}<div><h1>Benvenuto in <span>NovaTerm</span></h1><p>Terminale SSH moderno con Claude Code integrato.</p></div></div>
        <div class="cards">
          <button class="card" data-action="new-session"><div class="c-icon">${icon('server')}</div><b>Nuova sessione SSH</b><span>Host, utente, password o chiave</span></button>
          <button class="card" data-action="import-csv"><div class="c-icon">${icon('fileImport')}</div><b>Importa da CSV</b><span>Carica decine di server in un colpo</span></button>
          <button class="card" data-action="local-terminal"><div class="c-icon">${icon('terminal')}</div><b>Terminale locale</b><span>Shell del tuo computer</span></button>
          <button class="card" data-action="focus-claude"><div class="c-icon">${icon('sparkles')}</div><b>Chiedi a Claude</b><span>Esegue comandi sui server per te</span></button>
        </div>
        ${fallback.length ? `<div class="section-title">${recent.length ? 'Recenti' : 'Sessioni'}</div><div class="recent-list">${fallback.map((s) => `
          <div class="recent-item" data-sid="${s.id}"><div class="s-icon" style="width:30px;height:30px;border-radius:9px;display:grid;place-items:center;background:var(--bg-3)">${icon(s.type === 'local' ? 'terminal' : 'server')}</div>
          <div style="min-width:0;flex:1"><div style="font-weight:550;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(s.name)}</div><div class="s-sub">${esc(s.type === 'local' ? 'locale' : `${s.username ? s.username + '@' : ''}${s.host}`)}</div></div>
          <span style="color:var(--muted);font-size:11px">${s.lastUsed ? App.timeAgo(s.lastUsed) : ''}</span></div>`).join('')}</div>` : ''}
        <div class="shortcuts">
          <div><span>Connessione rapida</span><kbd>Ctrl K</kbd></div>
          <div><span>Terminale locale</span><kbd>Ctrl Shift T</kbd></div>
          <div><span>Chiudi scheda</span><kbd>Ctrl Shift W</kbd></div>
          <div><span>Scheda successiva</span><kbd>Ctrl Tab</kbd></div>
          <div><span>Cerca nel terminale</span><kbd>Ctrl Shift F</kbd></div>
          <div><span>Pannello Claude</span><kbd>Ctrl Shift K</kbd></div>
          <div><span>Copia / Incolla</span><kbd>Ctrl Shift C / V</kbd></div>
          <div><span>Nuova sessione</span><kbd>Ctrl Shift N</kbd></div>
        </div></div>`;
    },
  };

  // ------------------------------------------------------------ azioni
  const actions = {
    'new-session': () => App.Dialogs.sessionEditor(),
    'local-terminal': () => App.Terms.openLocal(),
    'import-csv': () => App.Dialogs.importCsv(),
    'multi-exec': () => App.Terms.setMulti(!App.Terms.multi),
    'toggle-claude': () => App.setClaudeOpen($('#claude-panel').classList.contains('collapsed')),
    'focus-claude': () => { App.setClaudeOpen(true); $('#claude-input').focus(); },
    'claude-new': () => App.Claude.newChat(),
    settings: () => App.Dialogs.settings(),
    'toggle-sidebar': () => { $('#sidebar').classList.toggle('collapsed'); requestAnimationFrame(() => App.Terms.fitActive()); },
    'sessions-menu': (e) => {
      const r = e.target.closest('button').getBoundingClientRect();
      contextMenu(r.left, r.bottom + 4, [
        { text: 'Nuova sessione', icon: 'plus', action: actions['new-session'] },
        { text: 'Importa da CSV…', icon: 'fileImport', action: actions['import-csv'] },
        { text: 'Esporta in CSV…', icon: 'fileExport', action: () => App.Dialogs.exportCsv() },
        '-',
        { text: 'Espandi tutti i gruppi', icon: 'chevronDown', action: () => { App.Sessions.collapsed.clear(); localStorage.setItem('nova.collapsedGroups', '[]'); App.Sessions.render(); } },
        { text: 'Comprimi tutti i gruppi', icon: 'chevronRight', action: () => { App.Sessions.groups().concat('Senza gruppo').forEach((g) => App.Sessions.collapsed.add(g)); localStorage.setItem('nova.collapsedGroups', JSON.stringify([...App.Sessions.collapsed])); App.Sessions.render(); } },
      ]);
    },
    'add-tab-menu': (e) => {
      const r = e.target.closest('button').getBoundingClientRect();
      const recent = [...App.Sessions.list].sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0)).slice(0, 8);
      contextMenu(r.left, r.bottom + 4, [
        { text: 'Terminale locale', icon: 'terminal', kbd: 'Ctrl+Shift+T', action: actions['local-terminal'] },
        { text: 'Nuova sessione SSH…', icon: 'plus', action: actions['new-session'] },
        recent.length && '-',
        recent.length && { label: 'Sessioni' },
        ...recent.map((s) => ({ text: s.name, icon: s.type === 'local' ? 'terminal' : 'server', action: () => App.Terms.openSession(s.id) })),
      ]);
    },
  };

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (el && actions[el.dataset.action]) actions[el.dataset.action](e);
    const ri = e.target.closest('.recent-item');
    if (ri) App.Terms.openSession(ri.dataset.sid);
  });

  // rail
  $$('.rail-btn[data-pane]').forEach((b) => b.addEventListener('click', () => {
    const pane = b.dataset.pane;
    const sidebar = $('#sidebar');
    if (b.classList.contains('active') && !sidebar.classList.contains('collapsed')) { sidebar.classList.add('collapsed'); requestAnimationFrame(() => App.Terms.fitActive()); return; }
    sidebar.classList.remove('collapsed');
    $$('.rail-btn[data-pane]').forEach((x) => x.classList.toggle('active', x === b));
    $$('.sidebar .pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === pane));
    if (pane === 'sftp') App.Sftp.onShow();
    requestAnimationFrame(() => App.Terms.fitActive());
  }));

  // resizer
  $$('.resizer').forEach((r) => r.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const which = r.dataset.resize;
    const startX = e.clientX;
    const startW = which === 'sidebar' ? $('#sidebar').offsetWidth : $('#claude-panel').offsetWidth;
    r.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    let w = startW;
    const move = (ev) => {
      const dx = ev.clientX - startX;
      w = Math.max(200, Math.min(which === 'sidebar' ? 520 : 760, which === 'sidebar' ? startW + dx : startW - dx));
      document.documentElement.style.setProperty(which === 'sidebar' ? '--sidebar-w' : '--claude-w', w + 'px');
      App.Terms.fitActive();
    };
    const up = () => {
      r.classList.remove('dragging');
      document.body.style.cursor = '';
      removeEventListener('mousemove', move); removeEventListener('mouseup', up);
      nova.invoke('settings:set', which === 'sidebar' ? { sidebarWidth: w } : { claudeWidth: w });
    };
    addEventListener('mousemove', move); addEventListener('mouseup', up);
  }));

  // quick connect
  $('#quick-connect').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.value.trim()) { App.Dialogs.quickConnect(e.target.value); e.target.value = ''; e.target.blur(); }
    if (e.key === 'Escape') { e.target.value = ''; e.target.blur(); App.Terms.active()?.term.focus(); }
  });

  // scorciatoie globali
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && !e.shiftKey && k === 'k') { e.preventDefault(); $('#quick-connect').focus(); return; }
    if (mod && e.shiftKey && k === 't') { e.preventDefault(); actions['local-terminal'](); return; }
    if (mod && e.shiftKey && k === 'n') { e.preventDefault(); actions['new-session'](); return; }
    if (mod && e.shiftKey && k === 'w') { e.preventDefault(); if (App.Terms.activeId) App.Terms.close(App.Terms.activeId); return; }
    if (mod && e.shiftKey && k === 'k') { e.preventDefault(); const open = $('#claude-panel').classList.contains('collapsed'); if (open || document.activeElement !== $('#claude-input')) { App.setClaudeOpen(true); $('#claude-input').focus(); } else { App.setClaudeOpen(false); App.Terms.active()?.term.focus(); } return; }
    if (e.ctrlKey && k === 'tab') { e.preventDefault(); App.Terms.cycle(e.shiftKey ? -1 : 1); return; }
    if (mod && !e.shiftKey && (k === '=' || k === '+')) { e.preventDefault(); App.saveSettings({ fontSize: Math.min(32, App.settings.fontSize + 1) }); return; }
    if (mod && !e.shiftKey && k === '-') { e.preventDefault(); App.saveSettings({ fontSize: Math.max(8, App.settings.fontSize - 1) }); return; }
    if (mod && !e.shiftKey && k === '0') { e.preventDefault(); App.saveSettings({ fontSize: 14 }); return; }
    if (mod && !e.shiftKey && /^[1-9]$/.test(e.key) && App.Terms.order.length) { e.preventDefault(); const id = App.Terms.order[Math.min(+e.key, App.Terms.order.length) - 1]; App.Terms.activate(id); }
  }, true);

  // drop globale di un CSV → import
  document.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
  document.addEventListener('drop', (e) => e.preventDefault());
  document.addEventListener('nova-file-drop', (e) => {
    const p = e.detail.paths[0];
    if (p && /\.(csv|tsv|txt)$/i.test(p)) App.Dialogs.importCsv(p);
  });

  // ------------------------------------------------------------ avvio
  async function boot() {
    document.getElementById('app').className = 'platform-' + (nova.platform === 'darwin' ? 'darwin' : 'other');
    UI.hydrate();
    const init = await nova.invoke('app:init');
    App.settings = init.settings;
    App.encryption = init.encryption;
    App.version = init.version;
    App.dataDir = init.dataDir;

    App.Sessions.init();
    App.Terms.init();
    App.Sftp.init();
    App.Claude.init();
    App.applySettings();
    App.Sessions.set(init.sessions);
    App.setClaudeOpen(init.settings.claudeOpen !== false);
    nova.onRequest('hostkey:ask', (info) => App.Dialogs.hostKey(info));
    App.Welcome.toggle(true);
    App.updateStatusbar();
    if (!App.encryption) setTimeout(() => toast('Portachiavi di sistema non disponibile: le password sono salvate con codifica semplice', 'warn', 6000), 800);
  }
  boot().catch((e) => { console.error(e); toast('Errore di avvio: ' + e.message, 'err', 10000); });
})();
