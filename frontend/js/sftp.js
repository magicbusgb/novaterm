/* Browser SFTP che segue la scheda SSH attiva (stile MobaXterm) */
(function () {
  const { $, esc, html, icon, contextMenu, toast, formatBytes, formatDate, promptDialog, confirmDialog } = window.UI;
  const App = (window.App = window.App || {});
  const posix = {
    join: (...p) => p.join('/').replace(/\/+/g, '/'),
    dirname: (p) => { const d = p.replace(/\/+$/, '').split('/').slice(0, -1).join('/'); return d || '/'; },
  };

  const Sftp = {
    termId: null,
    path: null,
    entries: [],
    selected: null,
    showHidden: localStorage.getItem('nova.sftpHidden') === '1',
    loading: false,

    tab() { return App.Terms.tabs.get(this.termId); },

    onActiveChanged() {
      const t = App.Terms.active();
      const usable = t && t.info.kind === 'ssh' && t.info.status === 'connected';
      if (!usable) {
        this.termId = null;
        this.renderEmpty(t ? (t.info.kind === 'local' ? 'Il browser SFTP è disponibile per le sessioni SSH.' : 'In attesa della connessione…') : 'Apri una sessione SSH per sfogliare i file remoti.');
        return;
      }
      if (this.termId === t.id && this.path) return;
      this.termId = t.id;
      if (this.isVisible()) this.load(t.sftpPath || null);
      else this.path = null;
    },

    isVisible() { return document.querySelector('.pane[data-pane="sftp"]').classList.contains('active'); },

    onShow() { if (this.termId && !this.path) this.load(this.tab()?.sftpPath || null); else if (!this.termId) this.onActiveChanged(); },

    renderEmpty(msg) {
      this.path = null;
      $('#sftp-path').value = '';
      $('#sftp-list').innerHTML = `<div class="sftp-empty">${icon('folder')}<p>${esc(msg)}</p></div>`;
    },

    async load(dir) {
      if (!this.termId) return;
      const id = this.termId;
      this.loading = true;
      $('#sftp-list').style.opacity = '.6';
      try {
        const r = await nova.invoke('sftp:list', id, dir || '.');
        if (id !== this.termId) return;
        this.path = r.path;
        this.entries = r.entries;
        const tab = this.tab(); if (tab) tab.sftpPath = r.path;
        this.selected = null;
        this.render();
      } catch (e) {
        toast(`SFTP: ${e.message}`, 'err');
        if (!this.path) this.renderEmpty(`Impossibile aprire SFTP: ${e.message}`);
      } finally {
        this.loading = false;
        $('#sftp-list').style.opacity = '';
      }
    },

    render() {
      $('#sftp-path').value = this.path;
      const list = this.entries.filter((e) => this.showHidden || !e.name.startsWith('.'));
      const frag = document.createDocumentFragment();
      if (this.path !== '/') frag.appendChild(html(`<div class="f-row dir" data-name="..">${icon('corner', 'f-ic')}<span class="f-name">..</span><span class="f-meta"></span></div>`));
      for (const e of list) {
        const isDir = e.type === 'dir' || e.linkToDir;
        frag.appendChild(html(`<div class="f-row ${isDir ? 'dir' : ''} ${e.name.startsWith('.') ? 'hiddenf' : ''}" data-name="${esc(e.name)}" title="${esc(e.longname || e.name)}">
          <span class="f-ic">${icon(isDir ? 'folder' : e.type === 'link' ? 'link' : 'file')}</span>
          <span class="f-name">${esc(e.name)}</span>
          <span class="f-meta">${isDir ? formatDate(e.mtime) : formatBytes(e.size)}</span></div>`));
      }
      if (!list.length) frag.appendChild(html(`<div class="sftp-empty">Cartella vuota</div>`));
      $('#sftp-list').replaceChildren(frag);
    },

    entry(name) { return this.entries.find((e) => e.name === name); },

    open(name) {
      if (name === '..') return this.load(posix.dirname(this.path));
      const e = this.entry(name);
      if (!e) return;
      if (e.type === 'dir' || e.linkToDir) return this.load(posix.join(this.path, name));
      return this.download(name);
    },

    async download(name) {
      try {
        const p = await nova.invoke('sftp:download', this.termId, posix.join(this.path, name));
        if (p) toast(`Scaricato: ${p}`, 'ok');
      } catch (e) { toast(`Download fallito: ${e.message}`, 'err'); }
    },

    async upload(paths) {
      if (!this.termId) return toast('Nessuna sessione SSH attiva', 'warn');
      try {
        const r = await nova.invoke('sftp:upload', this.termId, this.path, paths || []);
        if (r?.length) { toast(`${r.length} file caricati`, 'ok'); this.load(this.path); }
      } catch (e) { toast(`Upload fallito: ${e.message}`, 'err'); }
    },

    async mkdir() {
      const n = await promptDialog({ title: 'Nuova cartella', label: 'Nome', iconName: 'folderPlus' });
      if (!n) return;
      try { await nova.invoke('sftp:mkdir', this.termId, posix.join(this.path, n)); this.load(this.path); } catch (e) { toast(e.message, 'err'); }
    },

    async rename(name) {
      const n = await promptDialog({ title: 'Rinomina', label: 'Nuovo nome', value: name });
      if (!n || n === name) return;
      try { await nova.invoke('sftp:rename', this.termId, posix.join(this.path, name), posix.join(this.path, n)); this.load(this.path); } catch (e) { toast(e.message, 'err'); }
    },

    async remove(name) {
      const e = this.entry(name);
      const isDir = e.type === 'dir';
      const ok = await confirmDialog({ title: `Eliminare ${isDir ? 'la cartella' : 'il file'}?`, message: `<code>${esc(posix.join(this.path, name))}</code>${isDir ? '<br/><br/>Verrà eliminato tutto il contenuto.' : ''}`, okText: 'Elimina', danger: true, iconName: 'trash' });
      if (!ok) return;
      try { await nova.invoke('sftp:delete', this.termId, posix.join(this.path, name), isDir); this.load(this.path); } catch (err) { toast(err.message, 'err'); }
    },

    menu(name, x, y) {
      const e = name && name !== '..' ? this.entry(name) : null;
      const full = e ? posix.join(this.path, name) : this.path;
      contextMenu(x, y, [
        e && { text: e.type === 'dir' || e.linkToDir ? 'Apri' : 'Scarica…', icon: e.type === 'dir' ? 'folder' : 'download', action: () => this.open(name) },
        e && e.type !== 'dir' && { text: 'Analizza con Claude', icon: 'sparkles', action: () => App.Claude.quickAsk(`Leggi il file remoto \`${full}\` sul terminale ${this.termId} (usa read_remote_file) e spiegami cosa contiene, segnalando eventuali problemi.`) },
        e && { text: 'Rinomina…', icon: 'edit', action: () => this.rename(name) },
        { text: 'Copia percorso', icon: 'clipboard', action: () => { nova.clipboard.writeText(full); toast('Percorso copiato', 'ok', 1500); } },
        { text: 'Apri nel terminale (cd)', icon: 'terminal', action: () => { nova.write(this.termId, `cd ${JSON.stringify(e && (e.type === 'dir' || e.linkToDir) ? full : this.path)}\r`); App.Terms.active()?.term.focus(); } },
        '-',
        { text: 'Carica file qui…', icon: 'upload', action: () => this.upload() },
        { text: 'Nuova cartella…', icon: 'folderPlus', action: () => this.mkdir() },
        { text: this.showHidden ? 'Nascondi file nascosti' : 'Mostra file nascosti', icon: this.showHidden ? 'eyeOff' : 'eye', action: () => { this.showHidden = !this.showHidden; localStorage.setItem('nova.sftpHidden', this.showHidden ? '1' : '0'); this.render(); } },
        e && '-',
        e && { text: 'Elimina', icon: 'trash', danger: true, action: () => this.remove(name) },
      ]);
    },

    init() {
      const list = $('#sftp-list');
      list.addEventListener('click', (e) => {
        const row = e.target.closest('.f-row');
        list.querySelectorAll('.f-row.selected').forEach((r) => r.classList.remove('selected'));
        if (row) { row.classList.add('selected'); this.selected = row.dataset.name; }
      });
      list.addEventListener('dblclick', (e) => { const row = e.target.closest('.f-row'); if (row) this.open(row.dataset.name); });
      list.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (!this.termId || !this.path) return;
        const row = e.target.closest('.f-row');
        this.menu(row?.dataset.name, e.clientX, e.clientY);
      });
      list.addEventListener('dragover', (e) => { if (this.termId && e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.stopPropagation(); list.classList.add('drop'); } });
      list.addEventListener('dragleave', () => list.classList.remove('drop'));
      list.addEventListener('drop', (e) => { e.preventDefault(); list.classList.remove('drop'); });
      list.addEventListener('nova-file-drop', (e) => {
        e.stopPropagation();
        list.classList.remove('drop');
        if (this.termId && e.detail.paths.length) this.upload(e.detail.paths);
      });
      $('#sftp-path').addEventListener('keydown', (e) => { if (e.key === 'Enter' && this.termId) this.load(e.target.value.trim()); });
      document.querySelector('.pane[data-pane="sftp"] .pane-actions').addEventListener('click', (e) => {
        const act = e.target.closest('[data-sftp]')?.dataset.sftp;
        if (!act || !this.termId) return;
        if (act === 'up') this.load(posix.dirname(this.path));
        if (act === 'home') this.load('.');
        if (act === 'refresh') this.load(this.path);
        if (act === 'mkdir') this.mkdir();
        if (act === 'upload') this.upload();
      });

      const transfers = new Map();
      nova.on('sftp:progress', (p) => {
        let el = transfers.get(p.tid);
        if (p.finished) { if (el) { setTimeout(() => el.remove(), 600); transfers.delete(p.tid); } return; }
        if (!el) {
          el = html(`<div class="transfer"><div style="display:flex;gap:6px;align-items:center">${icon(p.dir === 'up' ? 'upload' : 'download')}<span class="t-name"></span><span class="t-pct" style="margin-left:auto;color:var(--muted)"></span></div><div class="bar"><i style="width:0"></i></div></div>`);
          $('.t-name', el).textContent = p.name;
          $('#sftp-transfers').appendChild(el);
          transfers.set(p.tid, el);
        }
        const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
        $('.bar i', el).style.width = pct + '%';
        $('.t-pct', el).textContent = `${pct}% · ${formatBytes(p.total)}`;
      });
      this.renderEmpty('Apri una sessione SSH per sfogliare i file remoti.');
    },
  };

  App.Sftp = Sftp;
})();
