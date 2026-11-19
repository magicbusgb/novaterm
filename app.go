package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	goruntime "runtime"
	"sync"
	"time"

	"github.com/google/uuid"
)

// Transport invia eventi al frontend (Wails o WebSocket nella modalità di test).
type Transport interface {
	Emit(name string, args ...any)
	OpenURL(url string)
	ClipboardGet() (string, error)
	ClipboardSet(text string) error
}

type FileFilter struct{ Name, Pattern string }

// Dialogs: finestre di dialogo native per file e cartelle.
type Dialogs interface {
	OpenFile(title string, filters []FileFilter) (string, error)
	OpenFiles(title string) ([]string, error)
	OpenDir(title string) (string, error)
	SaveFile(title, dir, name string, filters []FileFilter) (string, error)
}

// App è l'oggetto esposto al frontend. Tutte le chiamate passano da Invoke.
type App struct {
	store   *Store
	terms   *Manager
	claude  *Claude
	tr      Transport
	dlg     Dialogs
	ready   chan struct{}
	pending sync.Map // reqId -> chan json.RawMessage

	activeMu sync.RWMutex
	active   string

	csvMu    sync.Mutex
	csvCache map[string][]map[string]string

	outMu    sync.Mutex
	outBuf   map[string][]byte
	outTimer *time.Timer
}

func NewApp() *App {
	a := &App{ready: make(chan struct{}), csvCache: map[string][]map[string]string{}, outBuf: map[string][]byte{}}
	a.store = NewStore()
	a.terms = NewManager(a.store, a)
	a.claude = NewClaude(a)
	return a
}

func (a *App) attach(tr Transport, d Dialogs) {
	a.tr, a.dlg = tr, d
	close(a.ready)
	if err := a.claude.StartMCP(); err != nil {
		fmt.Fprintln(os.Stderr, "MCP:", err)
	}
}

func (a *App) shutdown() {
	a.claude.Stop()
	a.terms.CloseAll()
}

func (a *App) emit(name string, args ...any) {
	if a.tr != nil {
		a.tr.Emit(name, args...)
	}
}

// ------------------------------------------------------------------ output terminali (batch)

func (a *App) termData(id string, data []byte) {
	a.outMu.Lock()
	a.outBuf[id] = append(a.outBuf[id], data...)
	if a.outTimer == nil {
		a.outTimer = time.AfterFunc(6*time.Millisecond, a.flushData)
	}
	a.outMu.Unlock()
}

func (a *App) flushData() {
	a.outMu.Lock()
	buf := a.outBuf
	a.outBuf = map[string][]byte{}
	a.outTimer = nil
	a.outMu.Unlock()
	for id, d := range buf {
		a.emit("term:data", id, string(d))
	}
}

func (a *App) termStatus(ev map[string]any) {
	a.flushData()
	a.emit("term:status", ev)
}

// ------------------------------------------------------------------ richieste Go → frontend

// request chiede qualcosa al frontend (approvazioni, host key, lettura schermo) e attende la risposta.
func (a *App) request(channel string, payload map[string]any, timeout time.Duration, cancel <-chan struct{}) (json.RawMessage, error) {
	<-a.ready
	id := uuid.NewString()
	ch := make(chan json.RawMessage, 1)
	a.pending.Store(id, ch)
	defer a.pending.Delete(id)
	a.emit("rpc:request", map[string]any{"reqId": id, "channel": channel, "payload": payload})
	var tc <-chan time.Time
	if timeout > 0 {
		t := time.NewTimer(timeout)
		defer t.Stop()
		tc = t.C
	}
	select {
	case r := <-ch:
		return r, nil
	case <-tc:
		return nil, errors.New("timeout")
	case <-cancel:
		return nil, errors.New("annullato")
	}
}

// ------------------------------------------------------------------ metodi esposti al frontend

// Respond consegna la risposta del frontend a una request.
func (a *App) Respond(reqID string, result any) {
	if v, ok := a.pending.Load(reqID); ok {
		b, _ := json.Marshal(result)
		v.(chan json.RawMessage) <- b
	}
}

func (a *App) Write(id, data string)            { a.terms.Write(id, []byte(data)) }
func (a *App) Resize(id string, cols, rows int) { a.terms.Resize(id, cols, rows) }
func (a *App) SetActive(id string) {
	a.activeMu.Lock()
	a.active = id
	a.activeMu.Unlock()
}
func (a *App) activeTerminal() string {
	a.activeMu.RLock()
	defer a.activeMu.RUnlock()
	return a.active
}

// Invoke è il punto d'ingresso unico per le chiamate dal frontend (equivalente dell'IPC).
func (a *App) Invoke(channel string, args []json.RawMessage) (any, error) {
	arg := func(i int, v any) error {
		if i >= len(args) {
			return nil
		}
		return json.Unmarshal(args[i], v)
	}
	str := func(i int) string { var s string; _ = arg(i, &s); return s }

	switch channel {
	case "app:init":
		s := a.store.Settings()
		return map[string]any{
			"sessions": a.store.ListSessions(), "settings": a.publicSettings(s), "terminals": a.terms.List(),
			"platform": goruntime.GOOS, "encryption": a.store.KeyringOK(), "version": appVersion, "dataDir": a.store.dir,
		}, nil

	// ---- sessioni
	case "sessions:list":
		return a.store.ListSessions(), nil
	case "sessions:save":
		var in map[string]any
		if err := arg(0, &in); err != nil {
			return nil, err
		}
		return a.store.SaveSession(in)
	case "sessions:delete":
		var ids []string
		_ = arg(0, &ids)
		a.store.DeleteSessions(ids)
		return a.store.ListSessions(), nil
	case "sessions:rename-group":
		a.store.RenameGroup(str(0), str(1))
		return a.store.ListSessions(), nil
	case "sessions:duplicate":
		return a.store.Duplicate(str(0))

	// ---- CSV
	case "csv:pick":
		p, err := a.dlg.OpenFile("Importa sessioni da CSV", []FileFilter{{"CSV", "*.csv;*.txt;*.tsv"}, {"Tutti i file", "*.*"}})
		if err != nil || p == "" {
			return nil, err
		}
		return a.parseCSVFile(p)
	case "csv:parse-path":
		return a.parseCSVFile(str(0))
	case "csv:import":
		var in struct {
			Token          string `json:"token"`
			Indices        []int  `json:"indices"`
			SkipDuplicates bool   `json:"skipDuplicates"`
			Group          string `json:"group"`
		}
		_ = arg(0, &in)
		a.csvMu.Lock()
		rows, ok := a.csvCache[in.Token]
		delete(a.csvCache, in.Token)
		a.csvMu.Unlock()
		if !ok {
			return nil, errors.New("anteprima scaduta, reimporta il file")
		}
		var chosen []map[string]string
		for _, i := range in.Indices {
			if i >= 0 && i < len(rows) {
				r := rows[i]
				if in.Group != "" && r["group"] == "" {
					r["group"] = in.Group
				}
				chosen = append(chosen, r)
			}
		}
		added, updated, skipped := a.store.Import(chosen, in.SkipDuplicates)
		return map[string]any{"added": added, "updated": updated, "skipped": skipped, "sessions": a.store.ListSessions()}, nil
	case "csv:export":
		var in struct {
			IncludePasswords bool     `json:"includePasswords"`
			IDs              []string `json:"ids"`
		}
		_ = arg(0, &in)
		p, err := a.dlg.SaveFile("Esporta sessioni", "", "novaterm-sessioni.csv", []FileFilter{{"CSV", "*.csv"}})
		if err != nil || p == "" {
			return nil, err
		}
		data, err := ExportCSV(a.store.SessionsWithSecrets(in.IDs), in.IncludePasswords)
		if err != nil {
			return nil, err
		}
		return p, os.WriteFile(p, data, 0o600)
	case "csv:template":
		p, err := a.dlg.SaveFile("Salva modello CSV", "", "modello-sessioni.csv", []FileFilter{{"CSV", "*.csv"}})
		if err != nil || p == "" {
			return nil, err
		}
		return p, os.WriteFile(p, []byte(csvTemplate), 0o644)

	// ---- terminali
	case "term:open":
		var o OpenOpts
		_ = arg(0, &o)
		return a.terms.Open(o)
	case "term:close":
		a.terms.Close(str(0))
		return nil, nil
	case "term:reconnect":
		var o struct {
			Password     string `json:"password"`
			SavePassword bool   `json:"savePassword"`
		}
		_ = arg(1, &o)
		return a.terms.Reconnect(str(0), o.Password, o.SavePassword)
	case "term:list":
		return a.terms.List(), nil

	// ---- SFTP
	case "sftp:list":
		return a.terms.SftpList(str(0), str(1))
	case "sftp:mkdir":
		return true, a.terms.SftpMkdir(str(0), str(1))
	case "sftp:rename":
		return true, a.terms.SftpRename(str(0), str(1), str(2))
	case "sftp:delete":
		var isDir bool
		_ = arg(2, &isDir)
		return true, a.terms.SftpDelete(str(0), str(1), isDir)
	case "sftp:download":
		id, remote := str(0), str(1)
		home, _ := os.UserHomeDir()
		p, err := a.dlg.SaveFile("Scarica file", filepath.Join(home, "Downloads"), pathBase(remote), nil)
		if err != nil || p == "" {
			return nil, err
		}
		tid := uuid.NewString()
		err = a.terms.SftpDownload(id, remote, p, a.progress(tid, pathBase(remote), "down"))
		a.emit("sftp:progress", map[string]any{"tid": tid, "finished": true})
		return p, err
	case "sftp:upload":
		id, dir := str(0), str(1)
		var files []string
		_ = arg(2, &files)
		if len(files) == 0 {
			fs, err := a.dlg.OpenFiles("Carica file")
			if err != nil {
				return nil, err
			}
			files = fs
		}
		out := []string{}
		for _, f := range files {
			st, err := os.Stat(f)
			if err != nil || st.IsDir() {
				continue
			}
			tid := uuid.NewString()
			r, err := a.terms.SftpUpload(id, f, dir, a.progress(tid, filepath.Base(f), "up"))
			a.emit("sftp:progress", map[string]any{"tid": tid, "finished": true})
			if err != nil {
				return out, err
			}
			out = append(out, r)
		}
		return out, nil

	// ---- impostazioni e varie
	case "settings:set":
		var patch map[string]any
		_ = arg(0, &patch)
		delete(patch, "claudeApiKey")
		s, err := a.store.SetSettings(patch)
		return a.publicSettings(s), err
	case "settings:set-api-key":
		k := str(0)
		enc := ""
		if k != "" {
			enc = a.store.Encrypt(k)
		}
		_, err := a.store.SetSettings(map[string]any{"claudeApiKey": enc})
		return k != "", err
	case "dialog:pick-file":
		var o struct {
			Title string `json:"title"`
		}
		_ = arg(0, &o)
		return a.dlg.OpenFile(o.Title, nil)
	case "dialog:pick-dir":
		return a.dlg.OpenDir("Scegli cartella")
	case "shell:open-url":
		a.tr.OpenURL(str(0))
		return nil, nil
	case "clipboard:get":
		return a.tr.ClipboardGet()
	case "clipboard:set":
		return nil, a.tr.ClipboardSet(str(0))

	// ---- Claude
	case "claude:ask":
		var extra map[string]string
		_ = arg(1, &extra)
		return true, a.claude.Ask(str(0), extra)
	case "claude:stop":
		a.claude.Stop()
		return nil, nil
	case "claude:reset":
		a.claude.Reset()
		return nil, nil
	case "claude:status":
		return a.claude.Status(), nil
	}
	return nil, fmt.Errorf("canale sconosciuto: %s", channel)
}

func (a *App) publicSettings(s Settings) map[string]any {
	m := s.toMap()
	m["hasApiKey"] = s.ClaudeAPIKey != ""
	delete(m, "claudeApiKey")
	return m
}

func (a *App) progress(tid, name, dir string) func(done, total int64) {
	var last time.Time
	return func(done, total int64) {
		if time.Since(last) < 100*time.Millisecond && done < total {
			return
		}
		last = time.Now()
		a.emit("sftp:progress", map[string]any{"tid": tid, "name": name, "done": done, "total": total, "dir": dir})
	}
}

func (a *App) parseCSVFile(p string) (any, error) {
	data, err := os.ReadFile(p)
	if err != nil {
		return nil, err
	}
	res := ParseCSV(data)
	token := uuid.NewString()
	a.csvMu.Lock()
	a.csvCache[token] = res.Rows
	a.csvMu.Unlock()
	rows := make([]map[string]any, 0, len(res.Rows))
	for i, r := range res.Rows {
		rows = append(rows, map[string]any{
			"index": i, "name": r["name"], "host": r["host"], "port": r["port"], "username": r["username"], "group": r["group"],
			"type": r["type"], "hasPassword": r["password"] != "", "privateKeyPath": r["privateKeyPath"],
			"duplicate": a.store.FindDuplicate(r) != nil,
		})
	}
	return map[string]any{
		"token": token, "file": filepath.Base(p), "errors": res.Errors, "mapping": res.Mapping,
		"unknownColumns": res.Unknown, "rows": rows,
	}, nil
}

func pathBase(p string) string {
	for i := len(p) - 1; i >= 0; i-- {
		if p[i] == '/' {
			return p[i+1:]
		}
	}
	return p
}
