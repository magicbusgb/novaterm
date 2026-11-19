'use strict';
/**
 * Integrazione con Claude Code tramite il Claude Agent SDK.
 *
 * Claude riceve un server MCP in-process ("novaterm") con strumenti per vedere e pilotare
 * i terminali aperti in NovaTerm (SSH e locali). Ogni azione che modifica qualcosa passa
 * da canUseTool → richiesta di approvazione nel pannello Claude, a meno che l'utente
 * non abbia attivato l'auto-approvazione.
 */
const os = require('os');
const { z } = require('zod');

const SERVER = 'novaterm';
const T = (name) => `mcp__${SERVER}__${name}`;
const READ_ONLY_TOOLS = ['list_terminals', 'list_saved_sessions', 'read_terminal', 'read_remote_file'].map(T);
const NOVATERM_WRITE_TOOLS = ['run_command', 'run_command_multi', 'send_to_terminal', 'write_remote_file', 'open_session'].map(T);

const SYSTEM_APPEND = `
# NovaTerm
Stai lavorando dentro NovaTerm, un client SSH/terminale con schede. L'utente ti parla dal pannello laterale.
Hai accesso ai terminali aperti tramite gli strumenti mcp__novaterm__*:
- list_terminals: elenca le schede aperte (id tipo "t1", host, utente, stato). Il terminale attivo è indicato nel contesto del messaggio.
- run_command: esegue un comando NON interattivo su un terminale (canale separato, restituisce stdout/stderr/exit code). È il modo preferito per ispezionare o modificare un server.
- run_command_multi: lo stesso comando su più terminali in parallelo (es. "controlla lo spazio disco su tutti i server").
- send_to_terminal: digita testo nella shell interattiva visibile all'utente (usalo per comandi che devono restare visibili, che cambiano lo stato della shell come cd/export, o per programmi interattivi). Poi leggi l'output restituito.
- read_terminal: legge ciò che è attualmente visibile sullo schermo di un terminale.
- read_remote_file / write_remote_file: leggono/scrivono file remoti via SFTP.
- list_saved_sessions / open_session: elencano e aprono le sessioni salvate (le credenziali sono gestite da NovaTerm: non chiederle mai e non tentare di leggerle).
Regole:
- Se l'utente dice "qui", "su questo server" ecc. si riferisce al terminale attivo.
- Preferisci comandi non interattivi e idempotenti; usa flag come -y solo se l'utente lo ha chiesto. Evita pager (usa --no-pager, | cat).
- Prima di azioni distruttive (rm -rf, riavvii, modifiche di configurazione) spiega cosa farai: l'utente approverà ogni comando.
- Gli strumenti locali di Claude Code (Bash, Read, Edit...) agiscono sul computer dell'utente, NON sui server remoti.
- Rispondi nella lingua dell'utente, in modo conciso, con Markdown.`;

function textResult(obj, isError = false) {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
  return { content: [{ type: 'text', text }], isError };
}

class ClaudeBridge {
  /**
   * @param {object} deps
   * @param {import('./store').Store} deps.store
   * @param {import('./terminals').TerminalManager} deps.terms
   * @param {(event:object)=>void} deps.emit            invia eventi al pannello Claude
   * @param {(req:object)=>Promise<object>} deps.approve chiede approvazione all'utente
   * @param {(id:string, lines:number)=>Promise<string>} deps.readScreen
   * @param {(info:object)=>void} deps.adoptTerminal    apre una scheda per un terminale creato da Claude
   * @param {()=>string|null} deps.activeTerminal
   */
  constructor(deps) {
    Object.assign(this, deps);
    this.sdk = null;
    this.sessionId = null;
    this.running = false;
    this.abort = null;
    this.query = null;
    this.alwaysAllow = new Set();
  }

  async loadSdk() {
    if (!this.sdk) this.sdk = await import('@anthropic-ai/claude-agent-sdk');
    return this.sdk;
  }

  reset() {
    this.stop();
    this.sessionId = null;
    this.alwaysAllow.clear();
  }

  stop() {
    if (this.abort) { try { this.abort.abort(); } catch {} }
  }

  // ------------------------------------------------------------------ MCP tools

  buildServer() {
    const { tool, createSdkMcpServer } = this.sdk;
    const terms = this.terms;
    const termCheck = (id) => { terms.get(id); return id; };

    const tools = [
      tool('list_terminals', 'Elenca i terminali (schede) aperti in NovaTerm con id, tipo, host, utente e stato.', {},
        async () => {
          const active = this.activeTerminal();
          return textResult({ activeTerminal: active, terminals: terms.list() });
        }, { annotations: { readOnlyHint: true } }),

      tool('list_saved_sessions', 'Elenca le sessioni SSH salvate (senza credenziali). Filtro opzionale su nome/host/gruppo.',
        { filter: z.string().optional().describe('testo da cercare in nome, host o gruppo') },
        async ({ filter }) => {
          const f = (filter || '').toLowerCase();
          const list = this.store.listSessions()
            .filter((s) => !f || [s.name, s.host, s.group, s.username].some((v) => (v || '').toLowerCase().includes(f)))
            .map(({ id, name, host, port, username, group, type, notes }) => ({ id, name, host, port, username, group, type, notes }));
          return textResult(list);
        }, { annotations: { readOnlyHint: true } }),

      tool('open_session', 'Apre una sessione salvata in una nuova scheda e attende la connessione. Restituisce l\'id del terminale.',
        { session_id: z.string().describe('id della sessione salvata (da list_saved_sessions)') },
        async ({ session_id }) => {
          const info = terms.openSsh({ sessionId: session_id, cols: 140, rows: 36 });
          this.adoptTerminal(info);
          const status = await new Promise((resolve) => {
            const timer = setTimeout(() => { terms.off('status', on); resolve({ status: 'timeout' }); }, 30000);
            const on = (ev) => {
              if (ev.id !== info.id || ev.status === 'connecting') return;
              clearTimeout(timer); terms.off('status', on); resolve(ev);
            };
            terms.on('status', on);
          });
          return textResult({ terminal_id: info.id, status: status.status, message: status.message }, status.status !== 'connected');
        }),

      tool('run_command', 'Esegue un comando shell non interattivo su un terminale (SSH remoto o locale) in un canale separato e restituisce stdout, stderr ed exit code.',
        {
          terminal_id: z.string().describe('id del terminale, es. "t1"'),
          command: z.string().describe('comando da eseguire (sh/bash)'),
          timeout_sec: z.number().int().min(1).max(1800).optional().describe('timeout in secondi (default 120)'),
        },
        async ({ terminal_id, command, timeout_sec }) => {
          termCheck(terminal_id);
          this.emit({ type: 'terminal_activity', terminalId: terminal_id, command });
          const r = await terms.exec(terminal_id, command, { timeoutSec: timeout_sec || 120 });
          return textResult(r, !!r.error);
        }),

      tool('run_command_multi', 'Esegue lo stesso comando non interattivo su più terminali in parallelo.',
        {
          terminal_ids: z.array(z.string()).min(1).describe('id dei terminali'),
          command: z.string(),
          timeout_sec: z.number().int().min(1).max(1800).optional(),
        },
        async ({ terminal_ids, command, timeout_sec }) => {
          const results = await Promise.all(terminal_ids.map(async (id) => {
            try {
              const t = terms.get(id);
              this.emit({ type: 'terminal_activity', terminalId: id, command });
              return { terminal_id: id, host: t.host, ...(await terms.exec(id, command, { timeoutSec: timeout_sec || 120, maxOutput: 20000 })) };
            } catch (e) { return { terminal_id: id, error: e.message }; }
          }));
          return textResult(results);
        }),

      tool('send_to_terminal', 'Digita del testo nella shell interattiva visibile all\'utente e restituisce l\'output prodotto finché il terminale non torna inattivo. Per tasti speciali usa le sequenze: \\u0003 = Ctrl+C, \\u0004 = Ctrl+D, \\u001b = Esc.',
        {
          terminal_id: z.string(),
          text: z.string().describe('testo da digitare'),
          press_enter: z.boolean().optional().describe('invia Invio dopo il testo (default true)'),
          max_wait_ms: z.number().int().min(500).max(120000).optional().describe('attesa massima output (default 15000)'),
        },
        async ({ terminal_id, text, press_enter, max_wait_ms }) => {
          termCheck(terminal_id);
          this.emit({ type: 'terminal_activity', terminalId: terminal_id, command: text, interactive: true });
          const r = await terms.sendAndCapture(terminal_id, text, { pressEnter: press_enter !== false, maxWaitMs: max_wait_ms || 15000 });
          return textResult(r);
        }),

      tool('read_terminal', 'Legge il contenuto attuale dello schermo/scrollback di un terminale.',
        {
          terminal_id: z.string(),
          lines: z.number().int().min(1).max(2000).optional().describe('numero di righe finali (default 60)'),
        },
        async ({ terminal_id, lines }) => {
          termCheck(terminal_id);
          let text;
          try { text = await this.readScreen(terminal_id, lines || 60); } catch { text = terms.recentOutput(terminal_id, lines || 60); }
          return textResult(text || '(schermo vuoto)');
        }, { annotations: { readOnlyHint: true } }),

      tool('read_remote_file', 'Legge un file di testo su un server SSH via SFTP (max 200 KB).',
        { terminal_id: z.string(), path: z.string() },
        async ({ terminal_id, path }) => {
          const r = await terms.sftpReadFile(terminal_id, path);
          return textResult(r.content + (r.truncated ? '\n\n[file troncato a 200 KB]' : ''));
        }, { annotations: { readOnlyHint: true } }),

      tool('write_remote_file', 'Scrive (sovrascrive) un file di testo su un server SSH via SFTP.',
        { terminal_id: z.string(), path: z.string(), content: z.string() },
        async ({ terminal_id, path, content }) => {
          await terms.sftpWriteFile(terminal_id, path, content);
          return textResult(`Scritti ${Buffer.byteLength(content)} byte in ${path}`);
        }),
    ];
    return createSdkMcpServer({ name: SERVER, version: '1.0.0', tools, alwaysLoad: true });
  }

  // ------------------------------------------------------------------ permessi

  async canUseTool(toolName, input, opts) {
    const settings = this.store.settings;
    if (READ_ONLY_TOOLS.includes(toolName) || this.alwaysAllow.has(toolName)) return { behavior: 'allow', updatedInput: input };
    if (settings.claudeAutoApprove && NOVATERM_WRITE_TOOLS.includes(toolName)) return { behavior: 'allow', updatedInput: input };

    const terminalInfo = (id) => { try { return this.terms.describe(this.terms.get(id)); } catch { return null; } };
    const targets = input.terminal_id ? [terminalInfo(input.terminal_id)].filter(Boolean)
      : Array.isArray(input.terminal_ids) ? input.terminal_ids.map(terminalInfo).filter(Boolean) : [];

    const decision = await this.approve({
      toolName,
      shortName: toolName.replace(`mcp__${SERVER}__`, ''),
      input,
      targets,
      title: opts?.title,
      description: opts?.description || opts?.decisionReason,
      toolUseID: opts?.toolUseID,
      defaultToNo: !!opts?.defaultToNo,
      noAlways: !!opts?.suppressAlwaysAllowRule,
      signal: opts?.signal,
    });
    if (decision.allow) {
      if (decision.always && !opts?.suppressAlwaysAllowRule) this.alwaysAllow.add(toolName);
      return { behavior: 'allow', updatedInput: decision.updatedInput || input };
    }
    return { behavior: 'deny', message: decision.message || 'L\'utente ha rifiutato questa azione.', interrupt: !!decision.interrupt };
  }

  // ------------------------------------------------------------------ query

  contextBlock(extra) {
    const active = this.activeTerminal();
    const list = this.terms.list();
    const lines = list.map((t) => `- ${t.id}: ${t.title} [${t.kind}${t.kind === 'ssh' ? ` ${t.username}@${t.host}:${t.port}` : ''}] stato=${t.status}${t.id === active ? ' (ATTIVO)' : ''}`);
    let ctx = `<novaterm_context>\nTerminale attivo: ${active || 'nessuno'}\nTerminali aperti:\n${lines.join('\n') || '(nessuno)'}\n`;
    if (extra?.selection) ctx += `\nTesto selezionato dall'utente nel terminale ${active}:\n\`\`\`\n${extra.selection}\n\`\`\`\n`;
    return ctx + '</novaterm_context>\n\n';
  }

  async ask(prompt, extra = {}) {
    if (this.running) throw new Error('Claude sta già lavorando: attendi o premi Stop.');
    const sdk = await this.loadSdk();
    const settings = this.store.settings;
    this.running = true;
    this.abort = new AbortController();
    const turnId = Date.now().toString(36);
    this.emit({ type: 'turn_start', turnId });

    const env = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'novaterm/1.0.0' };
    const apiKey = this.store.decrypt(settings.claudeApiKey || '');
    if (apiKey) env.ANTHROPIC_API_KEY = apiKey;

    const options = {
      abortController: this.abort,
      cwd: settings.claudeWorkdir || os.homedir(),
      model: settings.claudeModel || undefined,
      effort: settings.claudeEffort || undefined,
      permissionMode: 'default',
      includePartialMessages: true,
      mcpServers: { [SERVER]: this.buildServer() },
      allowedTools: READ_ONLY_TOOLS,
      tools: settings.claudeLocalTools ? { type: 'preset', preset: 'claude_code' } : [],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: SYSTEM_APPEND },
      canUseTool: (name, input, opts) => this.canUseTool(name, input, opts),
      env,
      stderr: (data) => { if (/error/i.test(data)) console.error('[claude]', data.trim()); },
    };
    if (settings.claudePath) options.pathToClaudeCodeExecutable = settings.claudePath;
    if (this.sessionId) options.resume = this.sessionId;

    const streamedMessages = new Set();
    try {
      const q = sdk.query({ prompt: this.contextBlock(extra) + prompt, options });
      this.query = q;
      for await (const msg of q) this.handleMessage(msg, streamedMessages);
    } catch (e) {
      const aborted = this.abort?.signal.aborted;
      this.emit({ type: aborted ? 'aborted' : 'error', message: aborted ? 'Interrotto' : (e?.message || String(e)) });
    } finally {
      this.running = false;
      this.query = null;
      this.abort = null;
      this.emit({ type: 'turn_end', turnId });
    }
  }

  handleMessage(msg, streamed) {
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') {
          this.sessionId = msg.session_id;
          this.emit({ type: 'init', model: msg.model, sessionId: msg.session_id, tools: msg.tools?.length, cwd: msg.cwd });
        }
        break;
      case 'stream_event': {
        const ev = msg.event;
        if (msg.parent_tool_use_id) break;
        if (ev.type === 'content_block_start') {
          const b = ev.content_block;
          if (b.type === 'text') this.emit({ type: 'text_start' });
          else if (b.type === 'thinking') this.emit({ type: 'thinking' });
        } else if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
          this.emit({ type: 'text_delta', text: ev.delta.text });
          if (msg.message_id) streamed.add(msg.message_id);
          streamed.add('any');
        } else if (ev.type === 'message_start') {
          this.currentMessageId = ev.message?.id;
          streamed.delete('any');
        }
        break;
      }
      case 'assistant': {
        if (msg.error) this.emit({ type: 'error', message: `Errore API: ${msg.error}` });
        for (const block of msg.message.content || []) {
          if (block.type === 'text' && !streamed.has('any') && !msg.parent_tool_use_id) {
            this.emit({ type: 'text_start' });
            this.emit({ type: 'text_delta', text: block.text });
          } else if (block.type === 'tool_use') {
            this.emit({ type: 'tool_use', id: block.id, name: block.name, input: block.input, parent: msg.parent_tool_use_id });
          }
        }
        break;
      }
      case 'user': {
        const content = msg.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type !== 'tool_result') continue;
            const text = Array.isArray(block.content)
              ? block.content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n')
              : String(block.content ?? '');
            this.emit({ type: 'tool_result', id: block.tool_use_id, isError: !!block.is_error, text: text.slice(0, 20000) });
          }
        }
        break;
      }
      case 'result':
        this.sessionId = msg.session_id || this.sessionId;
        this.emit({
          type: 'result', subtype: msg.subtype, isError: msg.is_error, durationMs: msg.duration_ms,
          costUsd: msg.total_cost_usd, turns: msg.num_turns,
          errorText: msg.is_error ? (msg.result || (msg.errors || []).join('\n') || msg.subtype) : undefined,
        });
        break;
      default:
        break;
    }
  }
}

module.exports = { ClaudeBridge };
