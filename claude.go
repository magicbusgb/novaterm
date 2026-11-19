package main

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"sync"
	"time"
)

const mcpServerName = "novaterm"

func toolFull(n string) string { return "mcp__" + mcpServerName + "__" + n }

const systemAppend = `
# NovaTerm
Stai lavorando dentro NovaTerm, un client SSH/terminale con schede. L'utente ti parla dal pannello laterale.
Hai accesso ai terminali aperti tramite gli strumenti mcp__novaterm__*:
- list_terminals: elenca le schede aperte (id tipo "t1", host, utente, stato). Il terminale attivo è indicato nel contesto del messaggio.
- run_command: esegue un comando NON interattivo su un terminale (canale separato, restituisce stdout/stderr/exit code). È il modo preferito per ispezionare o modificare un server.
- run_command_multi: lo stesso comando su più terminali in parallelo (es. "controlla lo spazio disco su tutti i server").
- send_to_terminal: digita testo nella shell interattiva visibile all'utente (per comandi che devono restare visibili, che cambiano lo stato della shell come cd/export, o per programmi interattivi). Poi leggi l'output restituito.
- read_terminal: legge ciò che è attualmente visibile sullo schermo di un terminale.
- read_remote_file / write_remote_file: leggono/scrivono file remoti via SFTP.
- list_saved_sessions / open_session: elencano e aprono le sessioni salvate (le credenziali sono gestite da NovaTerm: non chiederle mai e non tentare di leggerle).
Regole:
- Se l'utente dice "qui", "su questo server" ecc. si riferisce al terminale attivo.
- Preferisci comandi non interattivi e idempotenti; evita pager (usa --no-pager, | cat).
- Prima di azioni distruttive (rm -rf, riavvii, modifiche di configurazione) spiega cosa farai: l'utente approva ogni comando e può modificarlo.
- Se un comando viene rifiutato, non riprovarlo: chiedi all'utente come procedere.
- Gli strumenti locali di Claude Code (Bash, Read, Edit...) agiscono sul computer dell'utente, NON sui server remoti.
- Rispondi nella lingua dell'utente, in modo conciso, con Markdown.`

type Claude struct {
	app *App

	mu          sync.Mutex
	running     bool
	sessionID   string
	cmd         *exec.Cmd
	cancel      chan struct{}
	alwaysAllow map[string]bool

	port  int
	token string
}

func NewClaude(a *App) *Claude { return &Claude{app: a, alwaysAllow: map[string]bool{}} }

func (c *Claude) Status() map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	return map[string]any{"running": c.running, "sessionId": c.sessionID}
}

func (c *Claude) emit(ev map[string]any) { c.app.emit("claude:event", ev) }

func (c *Claude) Reset() {
	c.Stop()
	c.mu.Lock()
	c.sessionID = ""
	c.alwaysAllow = map[string]bool{}
	c.mu.Unlock()
}

func (c *Claude) Stop() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.cancel != nil {
		select {
		case <-c.cancel:
		default:
			close(c.cancel)
		}
	}
	if c.cmd != nil && c.cmd.Process != nil {
		_ = c.cmd.Process.Kill()
	}
}

// ------------------------------------------------------------------ eseguibile claude

func (c *Claude) findClaude() (string, error) {
	if p := c.app.store.Settings().ClaudePath; p != "" {
		p = expandHome(p)
		if _, err := os.Stat(p); err == nil {
			return p, nil
		}
		return "", fmt.Errorf("eseguibile Claude Code non trovato in %s", p)
	}
	if p, err := exec.LookPath("claude"); err == nil {
		return p, nil
	}
	home, _ := os.UserHomeDir()
	var cands []string
	if goruntime.GOOS == "windows" {
		cands = []string{
			filepath.Join(home, ".local", "bin", "claude.exe"),
			filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", "claude", "claude.exe"),
			filepath.Join(os.Getenv("APPDATA"), "npm", "claude.cmd"),
		}
	} else {
		cands = []string{
			filepath.Join(home, ".local", "bin", "claude"),
			filepath.Join(home, ".claude", "local", "claude"),
			"/usr/local/bin/claude", "/opt/homebrew/bin/claude", "/usr/bin/claude",
			filepath.Join(home, ".npm-global", "bin", "claude"),
		}
	}
	for _, p := range cands {
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p, nil
		}
	}
	return "", errors.New("Claude Code non trovato. Installalo (https://claude.com/claude-code), esegui `claude` una volta per fare login, oppure indica il percorso in Impostazioni → Claude Code")
}

// ------------------------------------------------------------------ turno di conversazione

func (c *Claude) contextBlock(extra map[string]string) string {
	active := c.app.activeTerminal()
	var b strings.Builder
	b.WriteString("<novaterm_context>\nTerminale attivo: ")
	if active == "" {
		b.WriteString("nessuno")
	} else {
		b.WriteString(active)
	}
	b.WriteString("\nTerminali aperti:\n")
	list := c.app.terms.List()
	if len(list) == 0 {
		b.WriteString("(nessuno)\n")
	}
	for _, t := range list {
		fmt.Fprintf(&b, "- %s: %s [%s", t["id"], t["title"], t["kind"])
		if t["kind"] == "ssh" {
			fmt.Fprintf(&b, " %s@%s:%v", t["username"], t["host"], t["port"])
		}
		fmt.Fprintf(&b, "] stato=%s", t["status"])
		if t["id"] == active {
			b.WriteString(" (ATTIVO)")
		}
		b.WriteString("\n")
	}
	if sel := extra["selection"]; sel != "" {
		fmt.Fprintf(&b, "\nTesto selezionato dall'utente nel terminale %s:\n```\n%s\n```\n", active, sel)
	}
	b.WriteString("</novaterm_context>\n\n")
	return b.String()
}

var readOnlyTools = []string{"list_terminals", "list_saved_sessions", "read_terminal", "read_remote_file"}
var writeTools = []string{"run_command", "run_command_multi", "send_to_terminal", "write_remote_file", "open_session"}

func (c *Claude) Ask(prompt string, extra map[string]string) error {
	c.mu.Lock()
	if c.running {
		c.mu.Unlock()
		return errors.New("Claude sta già lavorando: attendi o premi Stop")
	}
	if c.port == 0 {
		c.mu.Unlock()
		return errors.New("server MCP di NovaTerm non avviato")
	}
	c.running = true
	c.cancel = make(chan struct{})
	resume := c.sessionID
	c.mu.Unlock()

	go c.run(prompt, extra, resume)
	return nil
}

func (c *Claude) run(prompt string, extra map[string]string, resume string) {
	turnID := fmt.Sprint(time.Now().UnixNano())
	c.emit(map[string]any{"type": "turn_start", "turnId": turnID})
	defer func() {
		c.mu.Lock()
		c.running, c.cmd = false, nil
		c.mu.Unlock()
		c.emit(map[string]any{"type": "turn_end", "turnId": turnID})
	}()
	fail := func(msg string) { c.emit(map[string]any{"type": "error", "message": msg}) }

	bin, err := c.findClaude()
	if err != nil {
		fail(err.Error())
		return
	}
	s := c.app.store.Settings()
	tmp, err := os.MkdirTemp("", "novaterm-claude-")
	if err != nil {
		fail(err.Error())
		return
	}
	defer os.RemoveAll(tmp)
	mcpCfg := map[string]any{"mcpServers": map[string]any{mcpServerName: map[string]any{
		"type": "http", "url": fmt.Sprintf("http://127.0.0.1:%d/mcp", c.port),
		"headers": map[string]string{"Authorization": "Bearer " + c.token},
	}}}
	mcpFile := filepath.Join(tmp, "mcp.json")
	b, _ := json.Marshal(mcpCfg)
	_ = os.WriteFile(mcpFile, b, 0o600)
	promptFile := filepath.Join(tmp, "system.md")
	_ = os.WriteFile(promptFile, []byte(systemAppend), 0o600)

	allowed := make([]string, 0, len(readOnlyTools)+len(writeTools))
	for _, t := range append(append([]string{}, readOnlyTools...), writeTools...) {
		allowed = append(allowed, toolFull(t)) // le azioni di scrittura chiedono conferma dentro lo strumento stesso
	}
	args := []string{
		"-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
		"--mcp-config", mcpFile, "--strict-mcp-config",
		"--permission-mode", "default", "--permission-prompt-tool", toolFull("approve"),
		"--allowedTools", strings.Join(allowed, ","),
		"--append-system-prompt-file", promptFile,
	}
	if s.ClaudeModel != "" {
		args = append(args, "--model", s.ClaudeModel)
	}
	if s.ClaudeEffort != "" {
		args = append(args, "--effort", s.ClaudeEffort)
	}
	if !s.ClaudeLocalTools {
		args = append(args, "--tools", "")
	}
	if resume != "" {
		args = append(args, "--resume", resume)
	}
	cmd := exec.Command(bin, args...)
	home, _ := os.UserHomeDir()
	cmd.Dir = home
	if s.ClaudeWorkdir != "" {
		cmd.Dir = expandHome(s.ClaudeWorkdir)
	}
	env := []string{}
	for _, e := range os.Environ() {
		if !strings.HasPrefix(e, "CLAUDECODE=") && !strings.HasPrefix(e, "CLAUDE_CODE_ENTRYPOINT=") {
			env = append(env, e)
		}
	}
	if k := c.app.store.Decrypt(s.ClaudeAPIKey); k != "" {
		env = append(env, "ANTHROPIC_API_KEY="+k)
	}
	cmd.Env = env
	hideWindow(cmd)
	stdin, _ := cmd.StdinPipe()
	stdout, _ := cmd.StdoutPipe()
	var stderr strings.Builder
	cmd.Stderr = &limitWriter{w: &stderr, n: 8000}
	if err := cmd.Start(); err != nil {
		fail("Impossibile avviare Claude Code: " + err.Error())
		return
	}
	c.mu.Lock()
	c.cmd = cmd
	cancel := c.cancel
	c.mu.Unlock()

	msg := map[string]any{"type": "user", "parent_tool_use_id": nil, "message": map[string]any{
		"role": "user", "content": []map[string]any{{"type": "text", "text": c.contextBlock(extra) + prompt}},
	}}
	line, _ := json.Marshal(msg)
	_, _ = stdin.Write(append(line, '\n'))

	gotResult := false
	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 1024*1024), 64*1024*1024)
	st := &streamState{}
	for sc.Scan() {
		var m map[string]any
		if json.Unmarshal(sc.Bytes(), &m) != nil {
			continue
		}
		if c.handle(m, st) {
			gotResult = true
			_ = stdin.Close()
		}
	}
	_ = stdin.Close()
	err = cmd.Wait()
	select {
	case <-cancel:
		c.emit(map[string]any{"type": "aborted"})
		return
	default:
	}
	if !gotResult {
		detail := strings.TrimSpace(stderr.String())
		if detail == "" && err != nil {
			detail = err.Error()
		}
		fail("Claude Code è terminato senza risposta. " + detail)
	}
}

type limitWriter struct {
	w io.Writer
	n int
}

func (l *limitWriter) Write(p []byte) (int, error) {
	if l.n > 0 {
		k := len(p)
		if k > l.n {
			k = l.n
		}
		l.n -= k
		_, _ = l.w.Write(p[:k])
	}
	return len(p), nil
}

type streamState struct{ streamedText bool }

func str(v any) string { s, _ := v.(string); return s }

// handle traduce i messaggi stream-json di Claude Code in eventi per il pannello. Ritorna true sul "result".
func (c *Claude) handle(m map[string]any, st *streamState) bool {
	switch str(m["type"]) {
	case "system":
		if str(m["subtype"]) == "init" {
			c.mu.Lock()
			c.sessionID = str(m["session_id"])
			c.mu.Unlock()
			c.emit(map[string]any{"type": "init", "model": m["model"], "sessionId": m["session_id"], "cwd": m["cwd"]})
		}
	case "stream_event":
		if m["parent_tool_use_id"] != nil {
			return false
		}
		ev, _ := m["event"].(map[string]any)
		switch str(ev["type"]) {
		case "message_start":
			st.streamedText = false
		case "content_block_start":
			cb, _ := ev["content_block"].(map[string]any)
			switch str(cb["type"]) {
			case "text":
				c.emit(map[string]any{"type": "text_start"})
			case "thinking":
				c.emit(map[string]any{"type": "thinking"})
			}
		case "content_block_delta":
			d, _ := ev["delta"].(map[string]any)
			if str(d["type"]) == "text_delta" {
				st.streamedText = true
				c.emit(map[string]any{"type": "text_delta", "text": d["text"]})
			}
		}
	case "assistant":
		if e := m["error"]; e != nil {
			c.emit(map[string]any{"type": "error", "message": fmt.Sprintf("Errore API: %v", e)})
		}
		msg, _ := m["message"].(map[string]any)
		content, _ := msg["content"].([]any)
		for _, x := range content {
			b, _ := x.(map[string]any)
			switch str(b["type"]) {
			case "text":
				if !st.streamedText && m["parent_tool_use_id"] == nil {
					c.emit(map[string]any{"type": "text_start"})
					c.emit(map[string]any{"type": "text_delta", "text": b["text"]})
				}
			case "tool_use":
				c.emit(map[string]any{"type": "tool_use", "id": b["id"], "name": b["name"], "input": b["input"], "parent": m["parent_tool_use_id"]})
			}
		}
	case "user":
		msg, _ := m["message"].(map[string]any)
		content, _ := msg["content"].([]any)
		for _, x := range content {
			b, _ := x.(map[string]any)
			if str(b["type"]) != "tool_result" {
				continue
			}
			var text string
			switch v := b["content"].(type) {
			case string:
				text = v
			case []any:
				parts := []string{}
				for _, p := range v {
					pm, _ := p.(map[string]any)
					if str(pm["type"]) == "text" {
						parts = append(parts, str(pm["text"]))
					} else {
						parts = append(parts, "["+str(pm["type"])+"]")
					}
				}
				text = strings.Join(parts, "\n")
			}
			if len(text) > 20000 {
				text = text[:20000]
			}
			isErr, _ := b["is_error"].(bool)
			c.emit(map[string]any{"type": "tool_result", "id": b["tool_use_id"], "isError": isErr, "text": text})
		}
	case "result":
		if sid := str(m["session_id"]); sid != "" {
			c.mu.Lock()
			c.sessionID = sid
			c.mu.Unlock()
		}
		isErr, _ := m["is_error"].(bool)
		ev := map[string]any{"type": "result", "subtype": m["subtype"], "isError": isErr, "durationMs": m["duration_ms"], "costUsd": m["total_cost_usd"], "turns": m["num_turns"]}
		if isErr {
			t := str(m["result"])
			if t == "" {
				if errs, ok := m["errors"].([]any); ok {
					for _, e := range errs {
						t += fmt.Sprint(e) + "\n"
					}
				}
			}
			if t == "" {
				t = str(m["subtype"])
			}
			ev["errorText"] = t
		}
		c.emit(ev)
		return true
	}
	return false
}

// ------------------------------------------------------------------ approvazioni

func (c *Claude) cancelChan() <-chan struct{} {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.cancel == nil {
		return nil
	}
	return c.cancel
}

type decision struct {
	Allow        bool           `json:"allow"`
	Always       bool           `json:"always"`
	UpdatedInput map[string]any `json:"updatedInput"`
	Message      string         `json:"message"`
}

// approve chiede all'utente di confermare un'azione. Restituisce l'input (eventualmente modificato).
func (c *Claude) approve(toolName string, input map[string]any, toolUseID string) (map[string]any, error) {
	short := strings.TrimPrefix(toolName, "mcp__"+mcpServerName+"__")
	c.mu.Lock()
	always := c.alwaysAllow[toolName]
	c.mu.Unlock()
	isNova := strings.HasPrefix(toolName, "mcp__"+mcpServerName+"__")
	if always || (isNova && c.app.store.Settings().ClaudeAutoApprove) {
		return input, nil
	}
	targets := []map[string]any{}
	addT := func(id string) {
		if t, err := c.app.terms.Get(id); err == nil {
			targets = append(targets, t.describe())
		}
	}
	if id, ok := input["terminal_id"].(string); ok {
		addT(id)
	}
	if ids, ok := input["terminal_ids"].([]any); ok {
		for _, x := range ids {
			if s, ok := x.(string); ok {
				addT(s)
			}
		}
	}
	raw, err := c.app.request("claude:approval", map[string]any{
		"toolName": toolName, "shortName": short, "input": input, "targets": targets, "toolUseID": toolUseID,
	}, 0, c.cancelChan())
	if err != nil {
		return nil, errors.New("azione annullata")
	}
	var d decision
	_ = json.Unmarshal(raw, &d)
	if !d.Allow {
		msg := d.Message
		if msg == "" {
			msg = "L'utente ha rifiutato questa azione. Chiedi come procedere invece di riprovare."
		}
		return nil, errors.New(msg)
	}
	if d.Always {
		c.mu.Lock()
		c.alwaysAllow[toolName] = true
		c.mu.Unlock()
	}
	if d.UpdatedInput != nil {
		return d.UpdatedInput, nil
	}
	return input, nil
}

// ------------------------------------------------------------------ server MCP (Streamable HTTP, risposte JSON)

func (c *Claude) StartMCP() error {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	tok := make([]byte, 24)
	_, _ = rand.Read(tok)
	c.mu.Lock()
	c.port = ln.Addr().(*net.TCPAddr).Port
	c.token = hex.EncodeToString(tok)
	c.mu.Unlock()
	mux := http.NewServeMux()
	mux.HandleFunc("/mcp", c.serveMCP)
	go func() { _ = http.Serve(ln, mux) }()
	return nil
}

type rpcReq struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

func (c *Claude) serveMCP(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Authorization") != "Bearer "+c.token {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	switch r.Method {
	case http.MethodPost:
	case http.MethodDelete:
		w.WriteHeader(http.StatusOK)
		return
	default:
		w.Header().Set("Allow", "POST, DELETE")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 32<<20))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	body = []byte(strings.TrimSpace(string(body)))
	var reqs []rpcReq
	batch := len(body) > 0 && body[0] == '['
	if batch {
		err = json.Unmarshal(body, &reqs)
	} else {
		var one rpcReq
		err = json.Unmarshal(body, &one)
		reqs = []rpcReq{one}
	}
	if err != nil {
		writeJSON(w, map[string]any{"jsonrpc": "2.0", "id": nil, "error": map[string]any{"code": -32700, "message": "parse error"}})
		return
	}
	var resps []map[string]any
	for _, q := range reqs {
		if len(q.ID) == 0 || string(q.ID) == "null" { // notifica
			continue
		}
		resps = append(resps, c.dispatch(q))
	}
	if len(resps) == 0 {
		w.WriteHeader(http.StatusAccepted)
		return
	}
	w.Header().Set("Mcp-Session-Id", "novaterm")
	if batch {
		writeJSON(w, resps)
	} else {
		writeJSON(w, resps[0])
	}
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func (c *Claude) dispatch(q rpcReq) map[string]any {
	resp := map[string]any{"jsonrpc": "2.0", "id": q.ID}
	switch q.Method {
	case "initialize":
		var p struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		_ = json.Unmarshal(q.Params, &p)
		if p.ProtocolVersion == "" {
			p.ProtocolVersion = "2025-06-18"
		}
		resp["result"] = map[string]any{
			"protocolVersion": p.ProtocolVersion,
			"capabilities":    map[string]any{"tools": map[string]any{"listChanged": false}},
			"serverInfo":      map[string]any{"name": mcpServerName, "version": appVersion},
		}
	case "ping":
		resp["result"] = map[string]any{}
	case "tools/list":
		resp["result"] = map[string]any{"tools": toolDefs()}
	case "tools/call":
		var p struct {
			Name      string         `json:"name"`
			Arguments map[string]any `json:"arguments"`
			Meta      map[string]any `json:"_meta"`
		}
		if err := json.Unmarshal(q.Params, &p); err != nil {
			resp["error"] = map[string]any{"code": -32602, "message": err.Error()}
			return resp
		}
		if p.Arguments == nil {
			p.Arguments = map[string]any{}
		}
		toolUseID := ""
		for k, v := range p.Meta {
			if strings.Contains(strings.ToLower(k), "tooluseid") || strings.Contains(strings.ToLower(k), "tool_use_id") {
				toolUseID, _ = v.(string)
			}
		}
		text, isErr := c.callTool(p.Name, p.Arguments, toolUseID)
		resp["result"] = map[string]any{"content": []map[string]any{{"type": "text", "text": text}}, "isError": isErr}
	default:
		resp["error"] = map[string]any{"code": -32601, "message": "method not found: " + q.Method}
	}
	return resp
}
