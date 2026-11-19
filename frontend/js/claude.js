/* Pannello Claude Code */
(function () {
  const { $, esc, html, icon, toast } = window.UI;
  const App = (window.App = window.App || {});

  const DANGER_RE = /\brm\s+-[a-z]*[rf]|\bmkfs\b|\bdd\s+if=|\bshutdown\b|\breboot\b|\bpoweroff\b|\bhalt\b|:\(\)\s*\{|\bchmod\s+-R\s+777\b|\bchown\s+-R\b|>\s*\/dev\/sd|\bsystemctl\s+(stop|disable|mask)\b|\bkill\s+-9\b|\bdrop\s+(table|database)\b|\btruncate\b|\biptables\s+-F\b|\buserdel\b|\bfdisk\b|\bparted\b|\bwipefs\b/i;

  const SUGGESTIONS = [
    { icon: 'hardDrive', text: 'Controlla spazio disco e memoria sul terminale attivo' },
    { icon: 'activity', text: 'Quali servizi systemd sono in errore? Mostrami i log rilevanti' },
    { icon: 'bug', text: 'Spiegami l\'errore che vedo ora sullo schermo' },
    { icon: 'layers', text: 'Esegui uptime e df -h su tutti i terminali aperti e fammi un riepilogo in tabella' },
  ];

  function termLabel(id) {
    const t = App.Terms.tabs.get(id);
    if (!t) return id;
    return t.info.kind === 'ssh' ? `${t.title}` : t.title;
  }

  function describeTool(name, input = {}) {
    const n = name.replace(/^mcp__novaterm__/, '');
    switch (n) {
      case 'run_command': return { ic: 'terminal', label: `Esegue su ${termLabel(input.terminal_id)}`, cmd: input.command };
      case 'run_command_multi': return { ic: 'layers', label: `Esegue su ${(input.terminal_ids || []).length} terminali`, cmd: input.command };
      case 'send_to_terminal': return { ic: 'keyboard', label: `Digita in ${termLabel(input.terminal_id)}`, cmd: input.text };
      case 'read_terminal': return { ic: 'monitor', label: `Legge lo schermo di ${termLabel(input.terminal_id)}`, cmd: '' };
      case 'list_terminals': return { ic: 'layers', label: 'Elenca i terminali aperti', cmd: '' };
      case 'list_saved_sessions': return { ic: 'server', label: 'Cerca tra le sessioni salvate', cmd: input.filter || '' };
      case 'open_session': return { ic: 'plug', label: 'Apre una sessione', cmd: App.Sessions.get(input.session_id)?.name || input.session_id };
      case 'read_remote_file': return { ic: 'fileText', label: `Legge file remoto su ${termLabel(input.terminal_id)}`, cmd: input.path };
      case 'write_remote_file': return { ic: 'edit', label: `Scrive file remoto su ${termLabel(input.terminal_id)}`, cmd: input.path };
      case 'Bash': return { ic: 'terminalSquare', label: 'Bash sul computer locale', cmd: input.command };
      case 'Read': return { ic: 'fileText', label: 'Legge file locale', cmd: input.file_path };
      case 'Write': return { ic: 'edit', label: 'Scrive file locale', cmd: input.file_path };
      case 'Edit': case 'MultiEdit': return { ic: 'edit', label: 'Modifica file locale', cmd: input.file_path };
      case 'Glob': case 'Grep': return { ic: 'search', label: `${n} locale`, cmd: input.pattern };
      case 'WebFetch': return { ic: 'globe', label: 'Legge pagina web', cmd: input.url };
      case 'WebSearch': return { ic: 'globe', label: 'Ricerca web', cmd: input.query };
      case 'TodoWrite': return { ic: 'check', label: 'Aggiorna la lista attività', cmd: '' };
      case 'Task': case 'Agent': return { ic: 'sparkles', label: 'Sotto-agente', cmd: input.description || '' };
      default: return { ic: 'wrench', label: n, cmd: input.command || input.path || input.file_path || '' };
    }
  }

  function editableField(shortName) {
    if (['run_command', 'run_command_multi', 'Bash'].includes(shortName)) return 'command';
    if (shortName === 'send_to_terminal') return 'text';
    return null;
  }

  const Claude = {
    running: false,
    selection: null,
    textEl: null,
    textBuf: '',
    renderPending: false,
    cards: new Map(),
    approvals: new Map(),

    el() { return $('#claude-messages'); },

    nearBottom() { const m = this.el(); return m.scrollHeight - m.scrollTop - m.clientHeight < 80; },
    scroll(force) { const m = this.el(); if (force || this.nearBottom()) requestAnimationFrame(() => { m.scrollTop = m.scrollHeight; }); },

    append(node, forceScroll) {
      $('.claude-empty', this.el())?.remove();
      this.el().appendChild(node);
      this.scroll(forceScroll);
      return node;
    },

    renderEmpty() {
      const box = html(`<div class="claude-empty">
          <div class="claude-mark">${icon('sparkles')}</div>
          <h3>Claude Code nei tuoi terminali</h3>
          <p>Chiedi in linguaggio naturale: Claude esegue i comandi sulle sessioni aperte, legge l'output e ti risponde. Ogni comando richiede la tua approvazione.</p>
          <div class="suggestions"></div></div>`);
      for (const s of SUGGESTIONS) {
        const b = html(`<button class="suggestion">${icon(s.icon)}<span></span></button>`);
        $('span', b).textContent = s.text;
        b.onclick = () => this.send(s.text);
        $('.suggestions', box).appendChild(b);
      }
      this.el().replaceChildren(box);
    },

    renderContext() {
      const ctx = $('#composer-ctx');
      ctx.innerHTML = '';
      const t = App.Terms.active();
      if (t) {
        ctx.appendChild(html(`<span class="chip" title="Claude considera questo il terminale attivo"><span class="status-dot ${t.info.status}"></span>${esc(t.id.startsWith('pending') ? '' : t.id + ' · ')}${esc(t.title)}</span>`));
      } else {
        ctx.appendChild(html(`<span class="chip">${icon('info')} Nessun terminale aperto</span>`));
      }
      if (this.selection) {
        const chip = html(`<span class="chip sel" title="${esc(this.selection.text.slice(0, 500))}">${icon('scroll')} Selezione (${this.selection.text.split('\n').length} righe)<button title="Rimuovi">${icon('x')}</button></span>`);
        $('button', chip).onclick = () => { this.selection = null; this.renderContext(); };
        ctx.appendChild(chip);
      }
    },

    attachSelection(text, termId) {
      this.selection = { text, termId };
      App.setClaudeOpen(true);
      this.renderContext();
      $('#claude-input').focus();
    },

    quickAsk(text) { App.setClaudeOpen(true); this.send(text); },

    setRunning(on) {
      this.running = on;
      const btn = $('#claude-send');
      btn.classList.toggle('stop', on);
      btn.innerHTML = icon(on ? 'stop' : 'send');
      btn.title = on ? 'Interrompi' : 'Invia (Enter)';
      $('.claude-head .claude-mark').classList.toggle('busy', on);
      $('#claude-sub').textContent = on ? 'Al lavoro…' : 'Pronto';
      App.updateStatusbar();
    },

    async send(text) {
      text = (text ?? $('#claude-input').value).trim();
      if (!text || this.running) return;
      $('#claude-input').value = '';
      this.autosize();
      const sel = this.selection;
      const u = html(`<div class="msg-user"></div>`);
      if (sel) u.appendChild(html(`<span class="sel-chip">${icon('scroll')} con selezione dal terminale</span>`));
      u.appendChild(document.createTextNode(text));
      this.append(u, true);
      this.selection = null;
      this.renderContext();
      this.setRunning(true);
      this.showThinking();
      try {
        await nova.invoke('claude:ask', text, sel ? { selection: sel.text } : {});
      } catch (e) {
        this.setRunning(false);
        this.error(e.message);
      }
    },

    showThinking(label = 'Claude sta pensando') {
      this.hideThinking();
      this.thinkingEl = this.append(html(`<div class="thinking-row"><span class="dots"><i></i><i></i><i></i></span><span>${esc(label)}…</span></div>`));
    },
    hideThinking() { this.thinkingEl?.remove(); this.thinkingEl = null; },

    flushText() {
      this.renderPending = false;
      if (!this.textEl) return;
      const raw = marked.parse(this.textBuf, { gfm: true, breaks: true });
      this.textEl.innerHTML = DOMPurify.sanitize(raw);
      this.decorateCode(this.textEl);
      this.scroll();
    },

    decorateCode(root) {
      root.querySelectorAll('pre').forEach((pre) => {
        if ($('.code-actions', pre)) return;
        const code = pre.innerText;
        const bar = html(`<div class="code-actions"><button data-a="copy">${icon('copy')}Copia</button><button data-a="paste" title="Incolla nel terminale attivo (senza Invio)">${icon('terminal')}Al terminale</button></div>`);
        bar.addEventListener('click', (e) => {
          const a = e.target.closest('[data-a]')?.dataset.a;
          if (a === 'copy') { nova.clipboard.writeText(code); toast('Copiato', 'ok', 1200); }
          if (a === 'paste') {
            const t = App.Terms.active();
            if (!t) return toast('Nessun terminale attivo', 'warn');
            t.term.paste(code.replace(/\n$/, ''));
            t.term.focus();
          }
        });
        pre.appendChild(bar);
      });
    },

    endText() {
      if (this.textEl) { this.flushText(); this.textEl.classList.remove('streaming-caret'); }
      this.textEl = null; this.textBuf = '';
    },

    error(message) {
      this.hideThinking();
      let hint = '';
      if (/login|api key|authenticat|401|credit|unauthor/i.test(message)) {
        hint = '\n\nAccedi a Claude Code eseguendo `claude` in un terminale locale e digitando /login, oppure imposta una API key in Impostazioni → Claude.';
      } else if (/ENOENT|spawn|executable/i.test(message)) {
        hint = '\n\nImpossibile avviare Claude Code. Verifica il percorso dell\'eseguibile in Impostazioni → Claude.';
      }
      const el = html(`<div class="msg-error"><b>Errore</b> — </div>`);
      el.appendChild(document.createTextNode(message + hint));
      this.append(el, true);
    },

    onEvent(ev) {
      switch (ev.type) {
        case 'turn_start': this.setRunning(true); break;
        case 'init': $('#claude-model-label').textContent = ev.model || ''; break;
        case 'thinking': if (!this.textEl) this.showThinking('Sta ragionando'); break;
        case 'text_start':
          this.hideThinking();
          this.endText();
          this.textEl = this.append(html(`<div class="msg-assistant streaming-caret"></div>`));
          break;
        case 'text_delta':
          if (!this.textEl) { this.hideThinking(); this.textEl = this.append(html(`<div class="msg-assistant streaming-caret"></div>`)); }
          this.textBuf += ev.text;
          if (!this.renderPending) { this.renderPending = true; requestAnimationFrame(() => this.flushText()); }
          break;
        case 'tool_use': this.endText(); this.hideThinking(); this.toolCard(ev); this.showThinking('In esecuzione'); break;
        case 'tool_result': this.toolResult(ev); this.showThinking(); break;
        case 'terminal_activity': App.Terms.markClaudeActivity(ev.terminalId); break;
        case 'result': {
          this.endText(); this.hideThinking();
          if (ev.isError && ev.errorText) this.error(ev.errorText);
          const secs = ev.durationMs ? (ev.durationMs / 1000).toFixed(1) + ' s' : '';
          const cost = ev.costUsd ? ` · $${ev.costUsd.toFixed(3)}` : '';
          this.append(html(`<div class="turn-footer"><span>${ev.isError ? '✕' : '✓'} ${secs}${cost}</span></div>`));
          break;
        }
        case 'error': this.endText(); this.error(ev.message); break;
        case 'aborted': this.endText(); this.hideThinking(); this.append(html(`<div class="turn-footer"><span>■ Interrotto</span></div>`)); break;
        case 'turn_end':
          this.endText(); this.hideThinking(); this.setRunning(false);
          for (const [id, card] of this.cards) if (card.classList.contains('running')) { card.classList.remove('running'); $('.tc-state', card).innerHTML = icon('alertCircle'); this.cards.delete(id); }
          for (const a of this.approvals.values()) a.resolve({ allow: false, message: 'Interrotto' });
          break;
        default: break;
      }
    },

    toolCard(ev) {
      if (ev.parent || ev.name === 'ToolSearch') return; // strumenti interni/dei sotto-agenti: non mostrati
      const d = describeTool(ev.name, ev.input);
      const card = html(`<div class="tool-card running">
          <div class="tc-head"><div class="tc-ic">${icon(d.ic)}</div>
            <div class="tc-main"><div class="tc-label"></div>${d.cmd ? '<div class="tc-cmd"></div>' : ''}</div>
            <div class="tc-state"><div class="mini-spin"></div></div></div>
          <div class="tc-body"><pre class="tc-input"></pre><pre class="tc-out">In attesa…</pre></div></div>`);
      $('.tc-label', card).textContent = d.label;
      if (d.cmd) $('.tc-cmd', card).textContent = String(d.cmd).split('\n')[0];
      $('.tc-input', card).textContent = JSON.stringify(ev.input, null, 2);
      $('.tc-head', card).onclick = () => card.classList.toggle('open');
      this.cards.set(ev.id, card);
      this.append(card);
      const pending = this.approvals.get(ev.id);
      if (pending) card.after(pending.el);
    },

    toolResult(ev) {
      const card = this.cards.get(ev.id);
      if (!card) return;
      card.classList.remove('running');
      card.classList.add(ev.isError ? 'err' : 'ok');
      $('.tc-state', card).innerHTML = icon(ev.isError ? 'alertCircle' : 'check');
      let out = ev.text;
      try {
        const j = JSON.parse(out);
        if (j && typeof j === 'object' && ('stdout' in j || 'output' in j)) {
          out = [j.stdout ?? j.output, j.stderr ? `\n[stderr]\n${j.stderr}` : '', j.exitCode !== undefined && j.exitCode !== null ? `\n[exit ${j.exitCode}${j.durationMs ? ` · ${j.durationMs} ms` : ''}]` : '', j.timedOut ? '\n[timeout]' : '', j.error ? `\n[errore] ${j.error}` : ''].join('');
          if (j.exitCode && j.exitCode !== 0) { card.classList.remove('ok'); card.classList.add('err'); $('.tc-state', card).innerHTML = `<span class="badge danger">exit ${j.exitCode}</span>`; }
        }
      } catch {}
      $('.tc-out', card).textContent = out || '(nessun output)';
      this.cards.delete(ev.id);
    },

    /** Richiesta di approvazione da canUseTool. */
    approval(req) {
      return new Promise((resolve) => {
        const field = editableField(req.shortName);
        const value = field ? String(req.input[field] ?? '') : '';
        const danger = DANGER_RE.test(value) || req.shortName === 'write_remote_file';
        const d = describeTool(req.toolName, req.input);
        const el = html(`<div class="approval ${danger ? 'danger' : ''}">
            <div class="ap-title">${icon(danger ? 'alert' : 'shield')}<span></span>${danger ? '<span class="badge danger">potenzialmente distruttivo</span>' : '<span class="badge">richiede approvazione</span>'}</div>
            <div class="targets"></div>
            ${field ? '<textarea spellcheck="false"></textarea>' : '<pre class="ap-pre" style="margin:0;max-height:200px;overflow:auto;font:11.5px var(--font-mono);background:var(--term-bg);padding:8px 10px;border-radius:8px;border:1px solid var(--border)"></pre>'}
            <div class="ap-desc"></div>
            <div class="ap-actions">
              <button class="btn primary sm" data-a="allow">${icon('play')} Esegui <kbd style="color:inherit;border-color:rgba(255,255,255,.4)">Ctrl ↵</kbd></button>
              ${req.noAlways ? '' : `<button class="btn sm" data-a="always" title="Non chiedere più per questo strumento in questa conversazione">${icon('check')} Consenti sempre</button>`}
              <button class="btn ghost sm" data-a="deny">${icon('x')} Rifiuta</button>
            </div></div>`);
        $('.ap-title span', el).textContent = req.title || d.label;
        const targets = $('.targets', el);
        for (const t of req.targets || []) {
          targets.appendChild(html(`<span class="chip"><span class="status-dot ${esc(t.status)}"></span>${esc(t.id)} · ${esc(t.kind === 'ssh' ? `${t.username}@${t.host}` : t.title)}</span>`));
        }
        if (!req.targets?.length) targets.remove();
        const ta = $('textarea', el);
        if (ta) { ta.value = value; ta.rows = Math.min(10, value.split('\n').length + 1); }
        else {
          const show = { ...req.input };
          if (typeof show.content === 'string' && show.content.length > 3000) show.content = show.content.slice(0, 3000) + '\n…';
          $('.ap-pre', el).textContent = JSON.stringify(show, null, 2);
        }
        $('.ap-desc', el).textContent = req.description || '';

        const finish = (decision) => {
          if (!this.approvals.has(req.toolUseID || el)) return;
          this.approvals.delete(req.toolUseID || el);
          const badge = decision.allow ? `<span class="badge ok">${decision.always ? 'sempre consentito' : 'approvato'}</span>` : '<span class="badge danger">rifiutato</span>';
          const card = req.toolUseID && this.cards.get(req.toolUseID);
          if (card) {
            el.remove();
            $('.tc-label', card).insertAdjacentHTML('beforeend', ' ' + badge);
            if (field && ta.value !== value) $('.tc-cmd', card).textContent = ta.value.split('\n')[0];
          } else {
            el.classList.add('resolved');
            $('.ap-title .badge', el).outerHTML = badge;
            if (ta) ta.readOnly = true;
          }
          resolve(decision);
          if (decision.allow) this.showThinking('In esecuzione');
        };
        const approve = (always) => {
          const updatedInput = field ? { ...req.input, [field]: ta.value } : undefined;
          finish({ allow: true, always, updatedInput });
        };
        el.addEventListener('click', (e) => {
          const a = e.target.closest('[data-a]')?.dataset.a;
          if (a === 'allow') approve(false);
          if (a === 'always') approve(true);
          if (a === 'deny') finish({ allow: false, message: 'L\'utente ha rifiutato. Chiedi come procedere invece di riprovare.' });
        });
        el.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); approve(false); }
          if (e.key === 'Escape') { e.preventDefault(); finish({ allow: false, message: 'L\'utente ha rifiutato.' }); }
        });
        this.approvals.set(req.toolUseID || el, { el, resolve: finish });
        this.hideThinking();
        const card = req.toolUseID && this.cards.get(req.toolUseID);
        if (card) { card.after(el); this.scroll(true); } else this.append(el, true);
        App.setClaudeOpen(true);
        setTimeout(() => (req.defaultToNo ? $('[data-a=deny]', el) : ta || $('[data-a=allow]', el)).focus(), 50);
        if (!document.hasFocus()) try { new Notification('NovaTerm — Claude chiede conferma', { body: `${d.label}: ${value || ''}`.slice(0, 160) }); } catch {}
      });
    },

    async newChat() {
      if (this.running) await nova.invoke('claude:stop');
      await nova.invoke('claude:reset');
      this.cards.clear();
      this.approvals.clear();
      this.textEl = null; this.textBuf = '';
      this.renderEmpty();
      $('#claude-model-label').textContent = '';
    },

    autosize() {
      const ta = $('#claude-input');
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 180) + 'px';
    },

    updateAutoBtn() {
      const on = !!App.settings.claudeAutoApprove;
      const b = $('#claude-auto');
      b.classList.toggle('on', on);
      b.innerHTML = icon(on ? 'shieldOff' : 'shield');
      b.title = on ? 'Auto-approvazione ATTIVA: i comandi sui terminali vengono eseguiti senza conferma (clic per disattivare)' : 'Auto-approvazione disattivata: ogni comando richiede conferma (clic per attivare)';
    },

    init() {
      nova.on('claude:event', (ev) => this.onEvent(ev));
      nova.onRequest('claude:approval', (req) => this.approval(req));
      const input = $('#claude-input');
      input.addEventListener('input', () => this.autosize());
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.send(); }
      });
      $('#claude-send').addEventListener('click', () => (this.running ? nova.invoke('claude:stop') : this.send()));
      $('#claude-auto').addEventListener('click', async () => {
        const on = !App.settings.claudeAutoApprove;
        if (on) {
          const ok = await UI.confirmDialog({ title: 'Attivare l\'auto-approvazione?', message: 'Claude potrà eseguire comandi sui tuoi server <b>senza chiedere conferma</b>. Gli strumenti locali di Claude Code continueranno a chiedere il permesso.', okText: 'Attiva', danger: true, iconName: 'shieldOff' });
          if (!ok) return;
        }
        await App.saveSettings({ claudeAutoApprove: on });
        this.updateAutoBtn();
      });
      this.renderEmpty();
      this.renderContext();
      this.updateAutoBtn();
    },
  };

  App.Claude = Claude;
})();
