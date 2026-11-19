/* Finestre di dialogo: editor sessione, import/export CSV, impostazioni, host key */
(function () {
  const { $, $$, esc, html, icon, modal, toast } = window.UI;
  const App = (window.App = window.App || {});
  const COLORS = ['', '#8b7cf6', '#4f8cff', '#14b8a6', '#34d399', '#fbbf24', '#f97316', '#f87171', '#ec4899'];

  const Dialogs = {
    // ------------------------------------------------------------ editor sessione
    sessionEditor(s = {}) {
      const isNew = !s.id;
      const groups = App.Sessions.groups();
      const body = html(`<form autocomplete="off" style="display:grid;gap:14px">
        <div class="segmented" data-type>
          <button type="button" data-v="ssh">${icon('server')} SSH</button>
          <button type="button" data-v="local">${icon('terminal')} Terminale locale</button>
        </div>
        <div class="grid-2">
          <div class="field"><label>Nome</label><input class="input" name="name" placeholder="es. Web server produzione" /></div>
          <div class="field"><label>Gruppo</label><input class="input" name="group" list="group-list" placeholder="es. Produzione" />
            <datalist id="group-list">${groups.map((g) => `<option value="${esc(g)}">`).join('')}</datalist></div>
        </div>
        <div class="ssh-only" style="display:grid;gap:14px">
          <div class="grid-3">
            <div class="field"><label>Host</label><input class="input mono" name="host" placeholder="192.168.1.10 o server.example.com" /></div>
            <div class="field"><label>Porta</label><input class="input mono" name="port" type="number" min="1" max="65535" placeholder="22" /></div>
          </div>
          <div class="grid-2">
            <div class="field"><label>Utente</label><input class="input mono" name="username" placeholder="root" /></div>
            <div class="field"><label>Password</label>
              <div class="input-group"><input class="input" name="password" type="password" placeholder="${s.hasPassword ? '•••••••• (salvata — lascia vuoto per non cambiarla)' : 'opzionale'}" />
              <button type="button" class="btn" data-a="showpw" title="Mostra">${icon('eye')}</button></div>
              ${s.hasPassword ? '<label class="check hint"><input type="checkbox" name="clearPassword" /> Rimuovi la password salvata</label>' : ''}
            </div>
          </div>
          <div class="field"><label>Chiave privata (opzionale)</label>
            <div class="input-group"><input class="input mono" name="privateKeyPath" placeholder="~/.ssh/id_ed25519" /><button type="button" class="btn" data-a="pickkey">${icon('key')} Sfoglia</button></div></div>
          <div class="field passphrase-field"><label>Passphrase della chiave</label><input class="input" name="passphrase" type="password" placeholder="${s.hasPassphrase ? '•••••••• (salvata)' : 'opzionale'}" /></div>
          <div class="field"><label>Comando all'avvio (opzionale)</label><input class="input mono" name="startupCommand" placeholder="es. cd /var/www && sudo -i" /></div>
        </div>
        <div class="field"><label>Note</label><textarea class="input" name="notes" rows="2" placeholder="Descrizione, ruolo del server… (Claude può leggerle)"></textarea></div>
        <div class="field"><label>Colore</label><div class="swatches">${COLORS.map((c) => `<span class="swatch" data-c="${c}" style="background:${c || 'var(--bg-4)'}" title="${c || 'nessuno'}"></span>`).join('')}</div></div>
      </form>`);
      const f = body;
      const set = (n, v) => { if (f.elements[n]) f.elements[n].value = v ?? ''; };
      ['name', 'group', 'host', 'username', 'privateKeyPath', 'startupCommand', 'notes'].forEach((n) => set(n, s[n]));
      set('port', s.port && s.port !== 22 ? s.port : '');
      let type = s.type || 'ssh';
      let color = s.color || '';
      const syncType = () => {
        $$('[data-type] button', f).forEach((b) => b.classList.toggle('on', b.dataset.v === type));
        $('.ssh-only', f).style.display = type === 'ssh' ? 'grid' : 'none';
      };
      const syncColor = () => $$('.swatch', f).forEach((sw) => sw.classList.toggle('on', sw.dataset.c === color));
      const syncPass = () => { $('.passphrase-field', f).style.display = f.elements.privateKeyPath.value ? 'grid' : 'none'; };
      syncType(); syncColor(); syncPass();
      f.elements.privateKeyPath.addEventListener('input', syncPass);
      f.addEventListener('click', async (e) => {
        const t = e.target.closest('[data-type] button'); if (t) { type = t.dataset.v; syncType(); }
        const sw = e.target.closest('.swatch'); if (sw) { color = sw.dataset.c; syncColor(); }
        const a = e.target.closest('[data-a]')?.dataset.a;
        if (a === 'showpw') { const p = f.elements.password; p.type = p.type === 'password' ? 'text' : 'password'; }
        if (a === 'pickkey') { const p = await nova.invoke('dialog:pick-file', { title: 'Scegli la chiave privata' }); if (p) { f.elements.privateKeyPath.value = p; syncPass(); } }
      });

      const m = modal({
        title: isNew ? 'Nuova sessione' : 'Modifica sessione', subtitle: isNew ? 'Le password vengono cifrate con il portachiavi di sistema' : s.name,
        iconName: isNew ? 'plus' : 'edit', body,
        footer: `<div class="left">${!isNew ? `<button class="btn ghost danger" data-a="delete">${icon('trash')} Elimina</button>` : ''}</div>
          <button class="btn ghost" data-a="cancel">Annulla</button>
          <button class="btn" data-a="save">Salva</button>
          <button class="btn primary" data-a="connect">${icon('play')} Salva e connetti</button>`,
      });
      const collect = () => {
        const v = (n) => f.elements[n]?.value ?? '';
        const out = { id: s.id, type, name: v('name'), group: v('group'), host: v('host'), port: v('port') || 22, username: v('username'),
          privateKeyPath: v('privateKeyPath'), startupCommand: v('startupCommand'), notes: v('notes'), color };
        if (v('password')) out.password = v('password');
        else if (f.elements.clearPassword?.checked) out.password = '';
        if (v('passphrase')) out.passphrase = v('passphrase');
        return out;
      };
      const save = async (connect) => {
        const data = collect();
        if (type === 'ssh' && !data.host) { f.elements.host.focus(); return toast('Inserisci l\'host', 'warn'); }
        try {
          const saved = await nova.invoke('sessions:save', data);
          App.Sessions.set(await nova.invoke('sessions:list'));
          m.close();
          toast(isNew ? 'Sessione creata' : 'Sessione salvata', 'ok', 1800);
          if (connect) App.Terms.openSession(saved.id);
        } catch (e) { toast(e.message, 'err'); }
      };
      m.foot.addEventListener('click', (e) => {
        const a = e.target.closest('[data-a]')?.dataset.a;
        if (a === 'cancel') m.close();
        if (a === 'save') save(false);
        if (a === 'connect') save(true);
        if (a === 'delete') { m.close(); App.Sessions.remove([s.id]); }
      });
      f.addEventListener('submit', (e) => { e.preventDefault(); save(true); });
      f.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); save(true); } });
      setTimeout(() => (isNew ? f.elements.host : f.elements.name).focus(), 50);
    },

    // ------------------------------------------------------------ import CSV
    importCsv(preParsed) {
      const body = html(`<div style="display:grid;gap:14px">
        <div class="dropzone" data-a="pick">
          <div class="big-icon">${icon('fileImport')}</div>
          <b>Trascina qui un file CSV oppure clicca per sceglierlo</b>
          <span>Separatore , ; o TAB rilevato automaticamente · intestazioni in italiano o inglese</span>
        </div>
        <div>
          <div class="field-label" style="margin-bottom:6px">Colonne riconosciute</div>
          <div class="csv-cols">name · group · host · port · username · password · private_key · passphrase · notes · type</div>
          <div class="hint" style="margin-top:6px;color:var(--muted);font-size:11.5px">Alias accettati: nome, gruppo/cartella, hostname/ip/indirizzo, porta, utente/user/login, pass/pwd, chiave… La colonna host può contenere anche <code>utente@host:porta</code>.</div>
        </div>
        <div class="notice">${icon('lock')}<div>Le password importate vengono cifrate con ${App.encryption ? 'il portachiavi del sistema operativo (safeStorage)' : '<b>una codifica semplice</b>: su questo sistema il portachiavi non è disponibile'}. Dopo l'importazione elimina il CSV in chiaro.</div></div>
        <div class="preview"></div>
      </div>`);
      const m = modal({
        title: 'Importa sessioni da CSV', subtitle: 'Host, utenti e password in blocco', iconName: 'fileImport', wide: true, body,
        footer: `<div class="left"><button class="btn ghost sm" data-a="template">${icon('download')} Scarica modello CSV</button></div>
          <button class="btn ghost" data-a="cancel">Annulla</button><button class="btn primary" data-a="import" disabled>${icon('fileImport')} Importa</button>`,
      });
      let parsed = null;
      const dz = $('.dropzone', body);
      const showPreview = (p) => {
        parsed = p;
        dz.innerHTML = `<div class="big-icon">${icon('checkCircle')}</div><b>${esc(p.file)}</b><span>${p.rows.length} righe valide · clicca per scegliere un altro file</span>`;
        const unknown = p.unknownColumns?.length ? `<div class="notice warn">${icon('alert')}<div>Colonne ignorate: ${p.unknownColumns.map(esc).join(', ')}</div></div>` : '';
        const errors = p.errors?.length ? `<div class="notice err">${icon('alertCircle')}<div>${p.errors.slice(0, 6).map((e) => `Riga ${e.line}: ${esc(e.message)}`).join('<br/>')}${p.errors.length > 6 ? `<br/>…e altri ${p.errors.length - 6}` : ''}</div></div>` : '';
        const dups = p.rows.filter((r) => r.duplicate).length;
        $('.preview', body).innerHTML = `${unknown}${errors}
          <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
            <label class="check"><input type="checkbox" data-o="skipdup" checked /> Salta i duplicati già presenti (${dups})</label>
            <label class="check" style="gap:6px">Gruppo per righe senza gruppo: <input class="input" data-o="group" style="height:28px;width:180px" placeholder="es. Importati" /></label>
          </div>
          <div class="preview-table-wrap"><table class="preview"><thead><tr>
            <th><input type="checkbox" data-o="all" checked /></th><th>Nome</th><th>Gruppo</th><th>Host</th><th>Porta</th><th>Utente</th><th>Auth</th><th></th>
          </tr></thead><tbody>${p.rows.map((r) => `<tr class="${r.duplicate ? 'dup' : ''}">
            <td><input type="checkbox" data-i="${r.index}" ${r.duplicate ? '' : 'checked'} /></td>
            <td>${esc(r.name || '—')}</td><td>${esc(r.group || '')}</td><td class="mono">${esc(r.type === 'local' ? 'locale' : r.host)}</td>
            <td class="mono">${esc(r.port || '22')}</td><td class="mono">${esc(r.username || '')}</td>
            <td>${r.hasPassword ? `<span class="badge ok">${icon('lock')}</span>` : r.privateKeyPath ? `<span class="badge">chiave</span>` : '<span class="badge">—</span>'}</td>
            <td>${r.duplicate ? '<span class="badge">duplicato</span>' : ''}</td></tr>`).join('')}</tbody></table></div>`;
        UI.hydrate($('.preview', body));
        const sync = () => {
          const n = $$('tbody input:checked', body).length;
          const btn = $('[data-a=import]', m.foot);
          btn.disabled = !n;
          btn.lastChild.textContent = ` Importa ${n} session${n === 1 ? 'e' : 'i'}`;
        };
        $('[data-o=all]', body).addEventListener('change', (e) => { $$('tbody input', body).forEach((c) => { c.checked = e.target.checked; }); sync(); });
        $('tbody', body).addEventListener('change', sync);
        sync();
      };
      const pick = async () => {
        try { const p = await nova.invoke('csv:pick'); if (p) showPreview(p); } catch (e) { toast(e.message, 'err'); }
      };
      const fromPath = async (path) => {
        try { showPreview(await nova.invoke('csv:parse-path', path)); } catch (e) { toast(e.message, 'err'); }
      };
      dz.addEventListener('click', pick);
      dz.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); dz.classList.add('over'); });
      dz.addEventListener('dragleave', () => dz.classList.remove('over'));
      dz.addEventListener('drop', (e) => {
        e.preventDefault(); e.stopPropagation(); dz.classList.remove('over');
        const f = e.dataTransfer.files[0];
        if (f) fromPath(nova.pathForFile(f));
      });
      m.foot.addEventListener('click', async (e) => {
        const a = e.target.closest('[data-a]')?.dataset.a;
        if (a === 'cancel') m.close();
        if (a === 'template') { const p = await nova.invoke('csv:template'); if (p) toast(`Modello salvato in ${p}`, 'ok'); }
        if (a === 'import' && parsed) {
          const indices = $$('tbody input:checked', body).map((c) => +c.dataset.i);
          try {
            const r = await nova.invoke('csv:import', { token: parsed.token, indices, skipDuplicates: $('[data-o=skipdup]', body).checked, group: $('[data-o=group]', body).value.trim() });
            App.Sessions.set(r.sessions);
            m.close();
            toast(`Importate ${r.added} sessioni${r.updated ? `, ${r.updated} aggiornate` : ''}${r.skipped ? `, ${r.skipped} saltate` : ''}`, 'ok', 5000);
          } catch (err) { toast(err.message, 'err'); }
        }
      });
      if (preParsed) fromPath(preParsed);
    },

    async exportCsv(ids) {
      const body = html(`<div style="display:grid;gap:12px">
        <p style="margin:0;color:var(--text-2)">${ids?.length ? `Esporta ${ids.length} sessioni selezionate` : `Esporta tutte le ${App.Sessions.list.length} sessioni`} in un file CSV compatibile con l'importazione.</p>
        <label class="check"><input type="checkbox" data-pw /> Includi le password in chiaro</label>
        <div class="notice warn">${icon('alert')}<div>Se includi le password, il file conterrà credenziali leggibili da chiunque. Conservalo in un luogo sicuro.</div></div></div>`);
      const m = modal({ title: 'Esporta sessioni', iconName: 'fileExport', body, footer: `<button class="btn ghost" data-a="cancel">Annulla</button><button class="btn primary" data-a="ok">${icon('download')} Esporta</button>` });
      m.foot.addEventListener('click', async (e) => {
        const a = e.target.closest('[data-a]')?.dataset.a;
        if (a === 'cancel') m.close();
        if (a === 'ok') {
          try {
            const p = await nova.invoke('csv:export', { includePasswords: $('[data-pw]', body).checked, ids });
            if (p) { m.close(); toast(`Esportato in ${p}`, 'ok'); }
          } catch (err) { toast(err.message, 'err'); }
        }
      });
    },

    // ------------------------------------------------------------ connessione rapida
    async quickConnect(str) {
      const m = str.trim().replace(/^ssh\s+/, '').match(/^(?:([^@\s]+)@)?(\[[^\]]+\]|[^:\s]+)(?::(\d+))?$/);
      if (!m) return toast('Formato: utente@host:porta', 'warn');
      const username = m[1] || '';
      const host = m[2].replace(/^\[|\]$/g, '');
      const port = +(m[3] || 22);
      const body = html(`<form style="display:grid;gap:12px">
        <div class="grid-2"><div class="field"><label>Utente</label><input class="input mono" name="u" /></div>
        <div class="field"><label>Password</label><input class="input" type="password" name="p" placeholder="vuoto = chiave/agent" /></div></div>
        <label class="check"><input type="checkbox" name="save" /> Salva come sessione</label></form>`);
      body.elements.u.value = username;
      const dlg = modal({ title: `Connetti a ${host}${port !== 22 ? ':' + port : ''}`, iconName: 'zap', body,
        footer: `<button class="btn ghost" data-a="cancel">Annulla</button><button class="btn primary" data-a="ok">${icon('plug')} Connetti</button>` });
      const go = async () => {
        const u = body.elements.u.value.trim(); const p = body.elements.p.value;
        dlg.close();
        if (body.elements.save.checked) {
          const s = await nova.invoke('sessions:save', { type: 'ssh', host, port, username: u, password: p || undefined });
          App.Sessions.set(await nova.invoke('sessions:list'));
          App.Terms.openSession(s.id);
        } else {
          App.Terms.quickConnect({ host, port, username: u, password: p });
        }
      };
      body.addEventListener('submit', (e) => { e.preventDefault(); go(); });
      dlg.foot.addEventListener('click', (e) => { const a = e.target.closest('[data-a]')?.dataset.a; if (a === 'cancel') dlg.close(); if (a === 'ok') go(); });
      setTimeout(() => (username ? body.elements.p : body.elements.u).focus(), 50);
    },

    // ------------------------------------------------------------ host key
    hostKey(info) {
      return new Promise((resolve) => {
        let accept = false;
        const m = modal({
          title: 'Host key cambiata!', subtitle: `${info.host}:${info.port}`, iconName: 'alert',
          body: `<div class="notice err">${icon('alertCircle')}<div>La chiave del server è diversa da quella salvata. Potrebbe trattarsi di una reinstallazione del server oppure di un attacco man-in-the-middle.</div></div>
            <div class="field"><label>Chiave salvata</label><code class="csv-cols">${esc(info.known)}</code></div>
            <div class="field"><label>Chiave ricevuta</label><code class="csv-cols">${esc(info.fingerprint)}</code></div>`,
          footer: `<button class="btn ghost" data-a="no">Annulla connessione</button><button class="btn danger" data-a="yes">Accetta la nuova chiave</button>`,
          onClose: () => resolve({ accept }),
        });
        m.foot.addEventListener('click', (e) => {
          const a = e.target.closest('[data-a]')?.dataset.a;
          if (a === 'yes') accept = true;
          if (a) m.close();
        });
      });
    },

    // ------------------------------------------------------------ impostazioni
    settings(tabName = 'look') {
      const s = App.settings;
      const body = document.createElement('div');
      const tabs = [['look', 'palette', 'Aspetto'], ['term', 'terminal', 'Terminale'], ['claude', 'sparkles', 'Claude Code'], ['data', 'database', 'Dati']];
      const m = modal({ title: 'Impostazioni', iconName: 'settings', wide: false, body, footer: `<span class="left" style="color:var(--muted);font-size:11.5px">NovaTerm ${esc(App.version)} · dati in ${esc(App.dataDir)}</span><button class="btn primary" data-a="close">Fatto</button>` });
      m.foot.addEventListener('click', (e) => { if (e.target.closest('[data-a=close]')) m.close(); });
      const tabBar = html(`<div class="modal-tabs">${tabs.map(([k, ic, l]) => `<button data-t="${k}">${icon(ic)}${l}</button>`).join('')}</div>`);
      m.modal.insertBefore(tabBar, m.body);
      const save = (patch) => App.saveSettings(patch);

      const row = (title, sub, control) => `<div class="setting-row"><div class="sr-text"><b>${title}</b>${sub ? `<span>${sub}</span>` : ''}</div>${control}</div>`;
      const sw = (key) => `<label class="switch"><input type="checkbox" data-k="${key}" ${s[key] ? 'checked' : ''}/><span></span></label>`;

      const panels = {
        look: () => `
          ${row('Tema', 'Aspetto dell\'interfaccia', `<div class="segmented" data-seg="theme"><button data-v="dark">${icon('moon')} Scuro</button><button data-v="light">${icon('sun')} Chiaro</button></div>`)}
          ${row('Colore principale', '', `<div class="swatches" data-seg="accent">${['violet', 'blue', 'teal', 'orange', 'pink'].map((a) => `<span class="swatch" data-v="${a}" style="background:${{ violet: '#8b7cf6', blue: '#4f8cff', teal: '#14b8a6', orange: '#f97316', pink: '#ec4899' }[a]}"></span>`).join('')}</div>`)}
          ${row('Tema del terminale', '', `<select class="input" style="width:190px" data-k="terminalTheme">${Object.entries(window.TermThemes).map(([k, t]) => `<option value="${k}">${t.label}</option>`).join('')}</select>`)}
          ${row('Dimensione carattere', 'Anche Ctrl + / Ctrl - nel terminale', `<input class="input" type="number" min="8" max="32" style="width:90px" data-k="fontSize" data-num />`)}
          ${row('Font del terminale', '', `<input class="input mono" style="width:260px" data-k="fontFamily" />`)}
          ${row('Cursore', '', `<div class="segmented" data-seg="cursorStyle"><button data-v="bar">Barra</button><button data-v="block">Blocco</button><button data-v="underline">Sottolineato</button></div>`)}`,
        term: () => `
          ${row('Copia alla selezione', 'Come in MobaXterm/PuTTY; tasto centrale per incollare', sw('copyOnSelect'))}
          ${row('Righe di scrollback', '', `<input class="input" type="number" min="500" max="200000" step="500" style="width:110px" data-k="scrollback" data-num />`)}
          ${row('Shell locale', 'Vuoto = predefinita del sistema', `<input class="input mono" style="width:220px" data-k="localShell" placeholder="/bin/zsh, pwsh.exe…" />`)}`,
        claude: () => `
          <div class="notice" style="margin:8px 0">${icon('info')}<div>NovaTerm usa il <b>Claude Agent SDK</b> (il motore di Claude Code). Se hai già fatto login con <code>claude</code> non serve altro; altrimenti inserisci una API key.</div></div>
          ${row('Modello', '', `<select class="input" style="width:220px" data-k="claudeModel">
              <option value="claude-opus-5-5">Claude Opus 5.5</option><option value="claude-sonnet-5-5">Claude Sonnet 5.5</option>
              <option value="claude-haiku-5-5">Claude Haiku 5.5</option><option value="claude-fable-5-2">Claude Fable 5.2</option></select>`)}
          ${row('Effort', 'Più alto = ragionamento più approfondito, più lento', `<select class="input" style="width:140px" data-k="claudeEffort"><option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="xhigh">xhigh</option><option value="max">max</option></select>`)}
          ${row('Auto-approva comandi sui terminali', 'Esegue run_command / send_to_terminal senza chiedere', sw('claudeAutoApprove'))}
          ${row('Strumenti locali di Claude Code', 'Bash, lettura/scrittura file, web… sul tuo computer (sempre con conferma)', sw('claudeLocalTools'))}
          ${row('API key Anthropic', s.hasApiKey ? 'Configurata (cifrata)' : 'Opzionale se hai già fatto login', `<div class="input-group" style="width:280px"><input class="input" type="password" data-apikey placeholder="${s.hasApiKey ? '••••••••' : 'sk-ant-…'}" /><button class="btn" data-a="savekey">Salva</button></div>`)}
          ${row('Eseguibile Claude Code', 'Vuoto = quello incluso nell\'SDK', `<input class="input mono" style="width:240px" data-k="claudePath" placeholder="/usr/local/bin/claude" />`)}
          ${row('Cartella di lavoro', 'Directory locale di Claude (vuoto = home)', `<input class="input mono" style="width:240px" data-k="claudeWorkdir" />`)}`,
        data: () => `
          ${row('Cifratura credenziali', App.encryption ? 'Portachiavi di sistema attivo (safeStorage)' : 'Portachiavi non disponibile: codifica semplice', `<span class="badge ${App.encryption ? 'ok' : 'danger'}">${App.encryption ? 'attiva' : 'debole'}</span>`)}
          ${row('Sessioni salvate', `${App.Sessions.list.length} sessioni`, `<div style="display:flex;gap:6px"><button class="btn sm" data-a="import">${icon('fileImport')} Importa</button><button class="btn sm" data-a="export">${icon('fileExport')} Esporta</button></div>`)}
          ${row('Modello CSV', 'File di esempio con tutte le colonne', `<button class="btn sm" data-a="template">${icon('download')} Scarica</button>`)}`,
      };

      const render = (k) => {
        $$('button', tabBar).forEach((b) => b.classList.toggle('on', b.dataset.t === k));
        body.innerHTML = panels[k]();
        UI.hydrate(body);
        $$('[data-k]', body).forEach((el) => {
          const key = el.dataset.k;
          if (el.type === 'checkbox') el.checked = !!App.settings[key];
          else el.value = App.settings[key] ?? '';
          el.addEventListener('change', () => {
            const v = el.type === 'checkbox' ? el.checked : el.dataset.num !== undefined ? +el.value : el.value;
            save({ [key]: v }).then(() => { if (key === 'claudeAutoApprove') App.Claude.updateAutoBtn(); });
          });
        });
        $$('[data-seg]', body).forEach((seg) => {
          const key = seg.dataset.seg;
          const sync = () => $$('[data-v]', seg).forEach((b) => b.classList.toggle('on', b.dataset.v === App.settings[key]));
          sync();
          seg.addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (b) save({ [key]: b.dataset.v }).then(sync); });
        });
        body.onclick = async (e) => {
          const a = e.target.closest('[data-a]')?.dataset.a;
          if (a === 'savekey') {
            const v = $('[data-apikey]', body).value.trim();
            await nova.invoke('settings:set-api-key', v);
            App.settings.hasApiKey = !!v;
            toast(v ? 'API key salvata' : 'API key rimossa', 'ok');
            render('claude');
          }
          if (a === 'import') { m.close(); this.importCsv(); }
          if (a === 'export') this.exportCsv();
          if (a === 'template') { const p = await nova.invoke('csv:template'); if (p) toast(`Modello salvato in ${p}`, 'ok'); }
        };
      };
      tabBar.addEventListener('click', (e) => { const b = e.target.closest('[data-t]'); if (b) render(b.dataset.t); });
      render(tabName);
    },
  };

  App.Dialogs = Dialogs;
})();
