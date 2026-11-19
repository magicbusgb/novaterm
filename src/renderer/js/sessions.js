/* Albero delle sessioni salvate */
(function () {
  const { $, esc, html, icon, contextMenu, confirmDialog, promptDialog, toast, timeAgo } = window.UI;
  const App = (window.App = window.App || {});

  const LS_COLLAPSED = 'nova.collapsedGroups';
  const NO_GROUP = 'Senza gruppo';

  const Sessions = {
    list: [],
    filter: '',
    selected: new Set(),
    lastClicked: null,
    collapsed: new Set(JSON.parse(localStorage.getItem(LS_COLLAPSED) || '[]')),

    set(list) { this.list = list; this.render(); App.Welcome?.render(); },

    get(id) { return this.list.find((s) => s.id === id); },

    groups() { return [...new Set(this.list.map((s) => s.group).filter(Boolean))].sort((a, b) => a.localeCompare(b)); },

    filtered() {
      const f = this.filter.trim().toLowerCase();
      if (!f) return this.list;
      return this.list.filter((s) => [s.name, s.host, s.username, s.group, s.notes].some((v) => (v || '').toLowerCase().includes(f)));
    },

    render() {
      const tree = $('#session-tree');
      const items = this.filtered();
      if (!this.list.length) {
        tree.innerHTML = `<div class="empty-state">${icon('server')}<p>Nessuna sessione salvata.<br/>Creane una o importa un CSV con host e password.</p>
          <button class="btn primary sm" data-action="new-session">${icon('plus')} Nuova sessione</button>
          <div style="height:8px"></div>
          <button class="btn sm" data-action="import-csv">${icon('fileImport')} Importa CSV</button></div>`;
        return;
      }
      if (!items.length) { tree.innerHTML = `<div class="empty-state">Nessun risultato per “${esc(this.filter)}”</div>`; return; }

      const byGroup = new Map();
      for (const s of items) {
        const g = s.group || NO_GROUP;
        if (!byGroup.has(g)) byGroup.set(g, []);
        byGroup.get(g).push(s);
      }
      const names = [...byGroup.keys()].sort((a, b) => (a === NO_GROUP) - (b === NO_GROUP) || a.localeCompare(b));
      const openIds = new Set(App.Terms?.openSessionIds() || []);
      const frag = document.createDocumentFragment();
      for (const g of names) {
        const list = byGroup.get(g).sort((a, b) => a.name.localeCompare(b.name));
        const collapsed = this.collapsed.has(g) && !this.filter;
        const head = html(`<div class="group-head ${collapsed ? 'collapsed' : ''}" data-group="${esc(g)}">
            <span class="chev">${icon('chevronDown')}</span>${icon(g === NO_GROUP ? 'layers' : 'folder')}
            <span>${esc(g)}</span><span class="count">${list.length}</span></div>`);
        const box = document.createElement('div');
        box.className = 'group-items' + (collapsed ? ' collapsed' : '');
        for (const s of list) {
          const sub = s.type === 'local' ? 'shell locale' : `${s.username ? s.username + '@' : ''}${s.host}${s.port && s.port !== 22 ? ':' + s.port : ''}`;
          const el = html(`<div class="session-item ${this.selected.has(s.id) ? 'selected' : ''} ${openIds.has(s.id) ? 'open' : ''}" data-id="${s.id}" title="${esc(s.notes || '')}">
              ${s.color ? `<span class="color-tag" style="background:${esc(s.color)}"></span>` : ''}
              <div class="s-icon">${icon(s.type === 'local' ? 'terminal' : 'server')}<span class="dot"></span></div>
              <div class="s-main"><div class="s-name">${esc(s.name)}</div><div class="s-sub">${esc(sub)}</div></div>
              ${s.hasPassword ? `<span class="s-key" title="Password salvata">${icon('lock')}</span>` : s.privateKeyPath ? `<span class="s-key" title="Chiave privata">${icon('key')}</span>` : ''}
              <div class="s-actions">
                <button class="icon-btn" data-act="connect" title="Connetti">${icon('play')}</button>
                <button class="icon-btn" data-act="edit" title="Modifica">${icon('edit')}</button>
              </div>
            </div>`);
          box.appendChild(el);
        }
        frag.append(head, box);
      }
      tree.replaceChildren(frag);
    },

    toggleGroup(g) {
      if (this.collapsed.has(g)) this.collapsed.delete(g); else this.collapsed.add(g);
      localStorage.setItem(LS_COLLAPSED, JSON.stringify([...this.collapsed]));
      this.render();
    },

    select(id, e) {
      if (e?.shiftKey && this.lastClicked) {
        const ids = [...document.querySelectorAll('.session-item')].map((n) => n.dataset.id);
        const [a, b] = [ids.indexOf(this.lastClicked), ids.indexOf(id)].sort((x, y) => x - y);
        ids.slice(a, b + 1).forEach((i) => this.selected.add(i));
      } else if (e?.ctrlKey || e?.metaKey) {
        if (this.selected.has(id)) this.selected.delete(id); else this.selected.add(id);
      } else {
        this.selected = new Set([id]);
      }
      this.lastClicked = id;
      document.querySelectorAll('.session-item').forEach((n) => n.classList.toggle('selected', this.selected.has(n.dataset.id)));
    },

    async remove(ids) {
      const names = ids.map((id) => this.get(id)?.name).filter(Boolean);
      const ok = await confirmDialog({
        title: ids.length > 1 ? `Eliminare ${ids.length} sessioni?` : 'Eliminare la sessione?',
        message: `${names.slice(0, 8).map(esc).join(', ')}${names.length > 8 ? '…' : ''}<br/><br/>Le credenziali salvate verranno cancellate.`,
        okText: 'Elimina', danger: true, iconName: 'trash',
      });
      if (!ok) return;
      this.set(await nova.invoke('sessions:delete', ids));
      this.selected.clear();
      toast(ids.length > 1 ? `${ids.length} sessioni eliminate` : 'Sessione eliminata', 'ok');
    },

    connectMany(ids) { ids.forEach((id) => App.Terms.openSession(id)); },

    itemMenu(id, x, y) {
      if (!this.selected.has(id)) this.select(id);
      const ids = [...this.selected];
      const multi = ids.length > 1;
      const s = this.get(id);
      contextMenu(x, y, [
        { text: multi ? `Connetti ${ids.length} sessioni` : 'Connetti', icon: 'play', action: () => this.connectMany(ids) },
        !multi && { text: 'Modifica…', icon: 'edit', action: () => App.Dialogs.sessionEditor(s) },
        !multi && { text: 'Duplica', icon: 'copy', action: async () => { await nova.invoke('sessions:duplicate', id); this.set(await nova.invoke('sessions:list')); } },
        !multi && s.type === 'ssh' && { text: 'Copia comando ssh', icon: 'clipboard', action: () => { navigator.clipboard.writeText(`ssh ${s.port !== 22 ? `-p ${s.port} ` : ''}${s.username ? s.username + '@' : ''}${s.host}`); toast('Copiato negli appunti', 'ok', 1500); } },
        '-',
        { text: 'Sposta nel gruppo…', icon: 'folder', action: () => this.moveToGroup(ids) },
        { text: multi ? 'Esporta selezionate in CSV' : 'Esporta in CSV', icon: 'fileExport', action: () => App.Dialogs.exportCsv(ids) },
        '-',
        { text: multi ? `Elimina ${ids.length} sessioni` : 'Elimina', icon: 'trash', danger: true, action: () => this.remove(ids) },
      ]);
    },

    groupMenu(g, x, y) {
      const ids = this.list.filter((s) => (s.group || NO_GROUP) === g).map((s) => s.id);
      contextMenu(x, y, [
        { text: `Connetti tutte (${ids.length})`, icon: 'play', action: () => this.connectMany(ids) },
        { text: 'Nuova sessione nel gruppo', icon: 'plus', action: () => App.Dialogs.sessionEditor({ group: g === NO_GROUP ? '' : g }) },
        g !== NO_GROUP && { text: 'Rinomina gruppo…', icon: 'edit', action: async () => {
          const n = await promptDialog({ title: 'Rinomina gruppo', label: 'Nuovo nome', value: g });
          if (n && n !== g) this.set(await nova.invoke('sessions:rename-group', g, n.trim()));
        } },
        { text: 'Esporta gruppo in CSV', icon: 'fileExport', action: () => App.Dialogs.exportCsv(ids) },
        '-',
        { text: 'Elimina tutte le sessioni del gruppo', icon: 'trash', danger: true, action: () => this.remove(ids) },
      ]);
    },

    async moveToGroup(ids) {
      const g = await promptDialog({ title: 'Sposta nel gruppo', label: 'Nome del gruppo (vuoto = nessun gruppo)', value: this.get(ids[0])?.group || '', iconName: 'folder' });
      if (g === null) return;
      for (const id of ids) await nova.invoke('sessions:save', { id, group: g.trim() });
      this.set(await nova.invoke('sessions:list'));
    },

    init() {
      const tree = $('#session-tree');
      tree.addEventListener('click', (e) => {
        const gh = e.target.closest('.group-head');
        if (gh) return this.toggleGroup(gh.dataset.group);
        const item = e.target.closest('.session-item');
        if (!item) return;
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'connect') return App.Terms.openSession(item.dataset.id);
        if (act === 'edit') return App.Dialogs.sessionEditor(this.get(item.dataset.id));
        this.select(item.dataset.id, e);
      });
      tree.addEventListener('dblclick', (e) => {
        const item = e.target.closest('.session-item');
        if (item && !e.target.closest('[data-act]')) App.Terms.openSession(item.dataset.id);
      });
      tree.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const item = e.target.closest('.session-item');
        if (item) return this.itemMenu(item.dataset.id, e.clientX, e.clientY);
        const gh = e.target.closest('.group-head');
        if (gh) return this.groupMenu(gh.dataset.group, e.clientX, e.clientY);
      });
      tree.addEventListener('keydown', (e) => {
        if (e.key === 'Delete' && this.selected.size) this.remove([...this.selected]);
        if (e.key === 'Enter' && this.selected.size) this.connectMany([...this.selected]);
      });
      tree.tabIndex = 0;
      $('#session-filter').addEventListener('input', (e) => { this.filter = e.target.value; this.render(); });
    },
  };

  App.Sessions = Sessions;
  App.timeAgo = timeAgo;
})();
