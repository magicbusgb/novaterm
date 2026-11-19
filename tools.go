package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

func obj(props map[string]any, required ...string) map[string]any {
	s := map[string]any{"type": "object", "properties": props, "additionalProperties": false}
	if len(required) > 0 {
		s["required"] = required
	}
	return s
}

func strP(desc string) map[string]any { return map[string]any{"type": "string", "description": desc} }
func intP(desc string, min, max int) map[string]any {
	return map[string]any{"type": "integer", "description": desc, "minimum": min, "maximum": max}
}

func toolDefs() []map[string]any {
	ro := map[string]any{"readOnlyHint": true}
	defs := []map[string]any{
		{"name": "list_terminals", "description": "Elenca i terminali (schede) aperti in NovaTerm con id, tipo, host, utente e stato.", "inputSchema": obj(map[string]any{}), "annotations": ro},
		{"name": "list_saved_sessions", "description": "Elenca le sessioni SSH salvate (senza credenziali). Filtro opzionale su nome/host/gruppo.",
			"inputSchema": obj(map[string]any{"filter": strP("testo da cercare in nome, host, gruppo o utente")}), "annotations": ro},
		{"name": "open_session", "description": "Apre una sessione salvata in una nuova scheda e attende la connessione. Restituisce l'id del terminale.",
			"inputSchema": obj(map[string]any{"session_id": strP("id della sessione salvata (da list_saved_sessions)")}, "session_id")},
		{"name": "run_command", "description": "Esegue un comando shell non interattivo su un terminale (SSH remoto o locale) in un canale separato e restituisce stdout, stderr ed exit code.",
			"inputSchema": obj(map[string]any{"terminal_id": strP(`id del terminale, es. "t1"`), "command": strP("comando da eseguire (sh/bash sul server; PowerShell per i terminali locali Windows)"), "timeout_sec": intP("timeout in secondi (default 120)", 1, 1800)}, "terminal_id", "command")},
		{"name": "run_command_multi", "description": "Esegue lo stesso comando non interattivo su più terminali in parallelo.",
			"inputSchema": obj(map[string]any{"terminal_ids": map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "minItems": 1, "description": "id dei terminali"}, "command": strP("comando"), "timeout_sec": intP("timeout in secondi (default 120)", 1, 1800)}, "terminal_ids", "command")},
		{"name": "send_to_terminal", "description": "Digita del testo nella shell interattiva visibile all'utente e restituisce l'output prodotto finché il terminale non torna inattivo. Tasti speciali: \\u0003 = Ctrl+C, \\u0004 = Ctrl+D, \\u001b = Esc.",
			"inputSchema": obj(map[string]any{"terminal_id": strP("id del terminale"), "text": strP("testo da digitare"), "press_enter": map[string]any{"type": "boolean", "description": "invia Invio dopo il testo (default true)"}, "max_wait_ms": intP("attesa massima dell'output (default 15000)", 500, 120000)}, "terminal_id", "text")},
		{"name": "read_terminal", "description": "Legge il contenuto attuale dello schermo/scrollback di un terminale.",
			"inputSchema": obj(map[string]any{"terminal_id": strP("id del terminale"), "lines": intP("numero di righe finali (default 60)", 1, 2000)}, "terminal_id"), "annotations": ro},
		{"name": "read_remote_file", "description": "Legge un file di testo su un server SSH via SFTP (max 200 KB).",
			"inputSchema": obj(map[string]any{"terminal_id": strP("id del terminale SSH"), "path": strP("percorso assoluto del file")}, "terminal_id", "path"), "annotations": ro},
		{"name": "write_remote_file", "description": "Scrive (sovrascrive) un file di testo su un server SSH via SFTP.",
			"inputSchema": obj(map[string]any{"terminal_id": strP("id del terminale SSH"), "path": strP("percorso assoluto del file"), "content": strP("contenuto completo")}, "terminal_id", "path", "content")},
		{"name": "approve", "description": "Uso interno di NovaTerm: chiede all'utente il permesso per gli strumenti locali di Claude Code. Non chiamarlo direttamente.",
			"inputSchema": map[string]any{"type": "object", "properties": map[string]any{"tool_name": strP(""), "input": map[string]any{"type": "object"}, "tool_use_id": strP("")}, "required": []string{"tool_name", "input"}}},
	}
	// sempre caricati: Claude non deve cercarli con ToolSearch
	for _, d := range defs {
		d["_meta"] = map[string]any{"anthropic/alwaysLoad": true}
	}
	return defs
}

func asJSON(v any) string {
	b, _ := json.MarshalIndent(v, "", "  ")
	return string(b)
}

func argStr(a map[string]any, k string) string { s, _ := a[k].(string); return s }
func argInt(a map[string]any, k string, def int) int {
	if f, ok := a[k].(float64); ok && f > 0 {
		return int(f)
	}
	return def
}

func (c *Claude) callTool(name string, args map[string]any, toolUseID string) (string, bool) {
	text, err := c.runTool(name, args, toolUseID)
	if err != nil {
		return err.Error(), true
	}
	return text, false
}

func (c *Claude) runTool(name string, args map[string]any, toolUseID string) (string, error) {
	terms := c.app.terms
	needTerm := func(id string) error { _, err := terms.Get(id); return err }
	gate := func() error { // conferma dell'utente per le azioni che modificano qualcosa
		in, err := c.approve(toolFull(name), args, toolUseID)
		if err != nil {
			return err
		}
		args = in
		return nil
	}

	switch name {
	case "list_terminals":
		return asJSON(map[string]any{"activeTerminal": c.app.activeTerminal(), "terminals": terms.List()}), nil

	case "list_saved_sessions":
		f := strings.ToLower(argStr(args, "filter"))
		out := []map[string]any{}
		for _, s := range c.app.store.ListSessions() {
			hay := strings.ToLower(fmt.Sprint(s["name"], " ", s["host"], " ", s["group"], " ", s["username"]))
			if f != "" && !strings.Contains(hay, f) {
				continue
			}
			out = append(out, map[string]any{"id": s["id"], "name": s["name"], "host": s["host"], "port": s["port"], "username": s["username"], "group": s["group"], "type": s["type"], "notes": s["notes"]})
		}
		return asJSON(out), nil

	case "open_session":
		if err := gate(); err != nil {
			return "", err
		}
		info, err := terms.OpenSSH(OpenOpts{SessionID: argStr(args, "session_id"), Cols: 140, Rows: 36})
		if err != nil {
			return "", err
		}
		c.app.emit("term:adopt", info)
		id := info["id"].(string)
		st, msg := terms.WaitStatus(id, 30*time.Second)
		res := asJSON(map[string]any{"terminal_id": id, "status": st, "message": msg})
		if st != "connected" {
			return "", errors.New(res)
		}
		return res, nil

	case "run_command":
		if err := gate(); err != nil {
			return "", err
		}
		id := argStr(args, "terminal_id")
		if err := needTerm(id); err != nil {
			return "", err
		}
		c.emit(map[string]any{"type": "terminal_activity", "terminalId": id, "command": args["command"]})
		r := terms.Exec(id, argStr(args, "command"), time.Duration(argInt(args, "timeout_sec", 120))*time.Second, 60000)
		if r.Error != "" {
			return "", errors.New(asJSON(r))
		}
		return asJSON(r), nil

	case "run_command_multi":
		if err := gate(); err != nil {
			return "", err
		}
		var ids []string
		if l, ok := args["terminal_ids"].([]any); ok {
			for _, x := range l {
				if s, ok := x.(string); ok {
					ids = append(ids, s)
				}
			}
		}
		cmd := argStr(args, "command")
		timeout := time.Duration(argInt(args, "timeout_sec", 120)) * time.Second
		results := make([]map[string]any, len(ids))
		var wg sync.WaitGroup
		for i, id := range ids {
			wg.Add(1)
			go func(i int, id string) {
				defer wg.Done()
				t, err := terms.Get(id)
				if err != nil {
					results[i] = map[string]any{"terminal_id": id, "error": err.Error()}
					return
				}
				c.emit(map[string]any{"type": "terminal_activity", "terminalId": id, "command": cmd})
				r := terms.Exec(id, cmd, timeout, 20000)
				results[i] = map[string]any{"terminal_id": id, "host": t.Host, "exitCode": r.ExitCode, "durationMs": r.DurationMs, "timedOut": r.TimedOut, "stdout": r.Stdout, "stderr": r.Stderr, "error": r.Error}
			}(i, id)
		}
		wg.Wait()
		return asJSON(results), nil

	case "send_to_terminal":
		if err := gate(); err != nil {
			return "", err
		}
		id := argStr(args, "terminal_id")
		enter := true
		if v, ok := args["press_enter"].(bool); ok {
			enter = v
		}
		c.emit(map[string]any{"type": "terminal_activity", "terminalId": id, "command": args["text"], "interactive": true})
		out, ms, err := terms.SendAndCapture(id, argStr(args, "text"), enter, time.Duration(argInt(args, "max_wait_ms", 15000))*time.Millisecond, 1200*time.Millisecond)
		if err != nil {
			return "", err
		}
		return asJSON(map[string]any{"output": out, "durationMs": ms}), nil

	case "read_terminal":
		id := argStr(args, "terminal_id")
		if err := needTerm(id); err != nil {
			return "", err
		}
		lines := argInt(args, "lines", 60)
		raw, err := c.app.request("term:read-screen", map[string]any{"id": id, "lines": lines}, 3*time.Second, nil)
		var text string
		if err == nil && json.Unmarshal(raw, &text) == nil {
			// ok
		} else {
			text = terms.RecentOutput(id, lines)
		}
		if strings.TrimSpace(text) == "" {
			text = "(schermo vuoto)"
		}
		return text, nil

	case "read_remote_file":
		content, trunc, err := terms.SftpReadFile(argStr(args, "terminal_id"), argStr(args, "path"), 200000)
		if err != nil {
			return "", err
		}
		if trunc {
			content += "\n\n[file troncato a 200 KB]"
		}
		return content, nil

	case "write_remote_file":
		if err := gate(); err != nil {
			return "", err
		}
		content := argStr(args, "content")
		if err := terms.SftpWriteFile(argStr(args, "terminal_id"), argStr(args, "path"), content); err != nil {
			return "", err
		}
		return fmt.Sprintf("Scritti %d byte in %s", len(content), argStr(args, "path")), nil

	case "approve":
		// Chiamato da Claude Code (--permission-prompt-tool) per gli strumenti locali.
		tool := argStr(args, "tool_name")
		input, _ := args["input"].(map[string]any)
		if input == nil {
			input = map[string]any{}
		}
		if strings.HasPrefix(tool, "mcp__"+mcpServerName+"__") {
			return asJSON(map[string]any{"behavior": "allow", "updatedInput": input}), nil
		}
		in, err := c.approve(tool, input, argStr(args, "tool_use_id"))
		if err != nil {
			return asJSON(map[string]any{"behavior": "deny", "message": err.Error()}), nil
		}
		return asJSON(map[string]any{"behavior": "allow", "updatedInput": in}), nil
	}
	return "", fmt.Errorf("strumento sconosciuto: %s", name)
}
