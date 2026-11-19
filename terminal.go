package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"os/user"
	"path"
	"path/filepath"
	"regexp"
	goruntime "runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"
)

const maxBuffer = 256 * 1024

var ansiRe = regexp.MustCompile(`\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[@-Z\\-_]|[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]`)

// stripAnsi rimuove i codici di controllo e tiene l'ultimo segmento delle righe riscritte con \r.
func stripAnsi(s string) string {
	s = ansiRe.ReplaceAllString(s, "")
	lines := strings.Split(s, "\n")
	for i, l := range lines {
		l = strings.TrimSuffix(l, "\r")
		if j := strings.LastIndex(l, "\r"); j >= 0 {
			l = l[j+1:]
		}
		lines[i] = l
	}
	return strings.Join(lines, "\n")
}

func truncateMiddle(s string, max int) string {
	if len(s) <= max {
		return s
	}
	half := max / 2
	return s[:half] + fmt.Sprintf("\n\n[... %d caratteri omessi ...]\n\n", len(s)-max) + s[len(s)-half:]
}

func expandHome(p string) string {
	if strings.HasPrefix(p, "~") {
		h, _ := os.UserHomeDir()
		return filepath.Join(h, p[1:])
	}
	return p
}

// LocalPTY astrae creack/pty (Unix) e ConPTY (Windows).
type LocalPTY interface {
	io.ReadWriter
	Resize(cols, rows int) error
	Close() error
	Wait() (int, error)
}

type Term struct {
	mu        sync.Mutex
	ID        string
	Kind      string
	Title     string
	SessionID string
	Host      string
	Port      int
	Username  string
	Status    string
	StartedAt int64
	Cols      int
	Rows      int
	Shell     string
	Cwd       string
	startup   string
	quickPw   string

	buffer    []byte
	listeners map[int]func([]byte)
	nextL     int

	client  *ssh.Client
	session *ssh.Session
	stdin   io.WriteCloser
	sftp    *sftp.Client
	pty     LocalPTY
	gen     int // generazione della connessione: ignora eventi di connessioni vecchie
}

type OpenOpts struct {
	Kind      string `json:"kind"`
	SessionID string `json:"sessionId"`
	Host      string `json:"host"`
	Port      int    `json:"port"`
	Username  string `json:"username"`
	Password  string `json:"password"`
	Title     string `json:"title"`
	Cols      int    `json:"cols"`
	Rows      int    `json:"rows"`
	Cwd       string `json:"cwd"`
}

type Manager struct {
	mu       sync.Mutex
	store    *Store
	app      *App
	terms    map[string]*Term
	seq      int
	statusMu sync.Mutex
	statusL  map[int]func(id, status, msg string)
	nextS    int
}

func NewManager(store *Store, app *App) *Manager {
	return &Manager{store: store, app: app, terms: map[string]*Term{}, statusL: map[int]func(string, string, string){}}
}

func (t *Term) describe() map[string]any {
	t.mu.Lock()
	defer t.mu.Unlock()
	return map[string]any{
		"id": t.ID, "kind": t.Kind, "title": t.Title, "sessionId": t.SessionID, "host": t.Host,
		"username": t.Username, "port": t.Port, "status": t.Status, "startedAt": t.StartedAt,
	}
}

func (m *Manager) List() []map[string]any {
	m.mu.Lock()
	list := make([]*Term, 0, len(m.terms))
	for _, t := range m.terms {
		list = append(list, t)
	}
	m.mu.Unlock()
	sort.Slice(list, func(i, j int) bool {
		return list[i].StartedAt < list[j].StartedAt || (list[i].StartedAt == list[j].StartedAt && list[i].ID < list[j].ID)
	})
	out := make([]map[string]any, 0, len(list))
	for _, t := range list {
		out = append(out, t.describe())
	}
	return out
}

func (m *Manager) Get(id string) (*Term, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	t, ok := m.terms[id]
	if !ok {
		return nil, fmt.Errorf("terminale %s non trovato", id)
	}
	return t, nil
}

func (m *Manager) newTerm(kind string, cols, rows int) *Term {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.seq++
	if cols <= 0 {
		cols = 120
	}
	if rows <= 0 {
		rows = 32
	}
	t := &Term{ID: fmt.Sprintf("t%d", m.seq), Kind: kind, Status: "connecting", StartedAt: time.Now().UnixMilli(), Cols: cols, Rows: rows, listeners: map[int]func([]byte){}}
	m.terms[t.ID] = t
	return t
}

func (m *Manager) setStatus(t *Term, gen int, status, msg string) {
	t.mu.Lock()
	if gen != t.gen {
		t.mu.Unlock()
		return
	}
	t.Status = status
	t.mu.Unlock()
	m.app.termStatus(map[string]any{"id": t.ID, "status": status, "message": msg, "info": t.describe()})
	m.statusMu.Lock()
	ls := make([]func(string, string, string), 0, len(m.statusL))
	for _, l := range m.statusL {
		ls = append(ls, l)
	}
	m.statusMu.Unlock()
	for _, l := range ls {
		l(t.ID, status, msg)
	}
}

// WaitStatus attende che il terminale esca dallo stato "connecting".
func (m *Manager) WaitStatus(id string, timeout time.Duration) (string, string) {
	ch := make(chan [2]string, 1)
	m.statusMu.Lock()
	m.nextS++
	key := m.nextS
	m.statusL[key] = func(tid, st, msg string) {
		if tid == id && st != "connecting" {
			select {
			case ch <- [2]string{st, msg}:
			default:
			}
		}
	}
	m.statusMu.Unlock()
	defer func() { m.statusMu.Lock(); delete(m.statusL, key); m.statusMu.Unlock() }()
	if t, err := m.Get(id); err == nil {
		t.mu.Lock()
		st := t.Status
		t.mu.Unlock()
		if st != "connecting" {
			return st, ""
		}
	}
	select {
	case r := <-ch:
		return r[0], r[1]
	case <-time.After(timeout):
		return "timeout", "connessione troppo lenta"
	}
}

func (m *Manager) onData(t *Term, data []byte) {
	t.mu.Lock()
	t.buffer = append(t.buffer, data...)
	if len(t.buffer) > maxBuffer {
		t.buffer = append([]byte(nil), t.buffer[len(t.buffer)-maxBuffer:]...)
	}
	ls := make([]func([]byte), 0, len(t.listeners))
	for _, l := range t.listeners {
		ls = append(ls, l)
	}
	t.mu.Unlock()
	for _, l := range ls {
		l(data)
	}
	m.app.termData(t.ID, data)
}

func (m *Manager) note(t *Term, s string) { m.onData(t, []byte("\x1b[2m[NovaTerm] "+s+"\x1b[0m\r\n")) }

// ------------------------------------------------------------------ apertura

func (m *Manager) Open(o OpenOpts) (map[string]any, error) {
	if o.Kind == "local" {
		return m.OpenLocal(o)
	}
	return m.OpenSSH(o)
}

func defaultShell() string {
	if goruntime.GOOS == "windows" {
		if p, err := exec.LookPath("pwsh.exe"); err == nil {
			return p
		}
		return "powershell.exe"
	}
	if s := os.Getenv("SHELL"); s != "" {
		return s
	}
	return "/bin/bash"
}

func (m *Manager) OpenLocal(o OpenOpts) (map[string]any, error) {
	shell := m.store.Settings().LocalShell
	if shell == "" {
		shell = defaultShell()
	}
	t := m.newTerm("local", o.Cols, o.Rows)
	home, _ := os.UserHomeDir()
	t.Shell, t.Cwd = shell, home
	if o.Cwd != "" {
		t.Cwd = expandHome(o.Cwd)
	}
	t.Title = o.Title
	if t.Title == "" {
		t.Title = "Locale (" + strings.TrimSuffix(filepath.Base(shell), ".exe") + ")"
	}
	t.Host = "localhost"
	if u, err := user.Current(); err == nil {
		t.Username = u.Username
	}
	go m.spawnLocal(t)
	return t.describe(), nil
}

func (m *Manager) spawnLocal(t *Term) {
	time.Sleep(20 * time.Millisecond) // lascia al frontend il tempo di creare la scheda
	t.mu.Lock()
	t.gen++
	gen := t.gen
	cols, rows, shell, cwd := t.Cols, t.Rows, t.Shell, t.Cwd
	t.mu.Unlock()
	p, err := startPTY(shell, cwd, cols, rows)
	if err != nil {
		m.setStatus(t, gen, "error", err.Error())
		return
	}
	t.mu.Lock()
	t.pty = p
	t.mu.Unlock()
	m.setStatus(t, gen, "connected", "")
	go func() {
		buf := make([]byte, 32*1024)
		for {
			n, err := p.Read(buf)
			if n > 0 {
				m.onData(t, append([]byte(nil), buf[:n]...))
			}
			if err != nil {
				return
			}
		}
	}()
	code, _ := p.Wait()
	m.setStatus(t, gen, "closed", fmt.Sprintf("Processo terminato (codice %d)", code))
}

func (m *Manager) OpenSSH(o OpenOpts) (map[string]any, error) {
	var cfg *Session
	if o.SessionID != "" {
		s, ok := m.store.SessionSecrets(o.SessionID)
		if !ok {
			return nil, errors.New("sessione non trovata")
		}
		cfg = s
		m.store.Touch(o.SessionID)
	} else {
		cfg = &Session{Host: o.Host, Port: o.Port, Username: o.Username, Password: o.Password, Name: o.Title}
		if cfg.Port == 0 {
			cfg.Port = 22
		}
	}
	t := m.newTerm("ssh", o.Cols, o.Rows)
	t.SessionID, t.Host, t.Port, t.Username, t.startup = o.SessionID, cfg.Host, cfg.Port, cfg.Username, cfg.StartupCommand
	t.Title = cfg.Name
	if t.Title == "" {
		t.Title = cfg.Username + "@" + cfg.Host
	}
	if o.SessionID == "" {
		t.quickPw = o.Password
	}
	go m.connectSSH(t, cfg)
	return t.describe(), nil
}

func (m *Manager) hostKeyCallback(t *Term, host string, port int) ssh.HostKeyCallback {
	return func(_ string, _ net.Addr, key ssh.PublicKey) error {
		fp := ssh.FingerprintSHA256(key)
		known := m.store.HostKey(host, port)
		if known == fp {
			return nil
		}
		if known == "" {
			m.store.SaveHostKey(host, port, fp)
			m.note(t, fmt.Sprintf("Nuova host key per %s: %s (salvata)", host, fp))
			return nil
		}
		raw, err := m.app.request("hostkey:ask", map[string]any{"host": host, "port": port, "known": known, "fingerprint": fp}, 0, nil)
		if err != nil {
			return err
		}
		var r struct {
			Accept bool `json:"accept"`
		}
		_ = json.Unmarshal(raw, &r)
		if !r.Accept {
			return errors.New("host key rifiutata")
		}
		m.store.SaveHostKey(host, port, fp)
		return nil
	}
}

func (m *Manager) connectSSH(t *Term, cfg *Session) {
	time.Sleep(20 * time.Millisecond)
	t.mu.Lock()
	t.gen++
	gen := t.gen
	cols, rows := t.Cols, t.Rows
	t.mu.Unlock()
	addr := net.JoinHostPort(cfg.Host, fmt.Sprint(cfg.Port))
	m.setStatus(t, gen, "connecting", "Connessione a "+addr+"...")

	username := cfg.Username
	if username == "" {
		if u, err := user.Current(); err == nil {
			username = u.Username
		}
	}
	var auths []ssh.AuthMethod
	var closers []io.Closer
	if cfg.PrivateKeyPath != "" {
		if pem, err := os.ReadFile(expandHome(cfg.PrivateKeyPath)); err != nil {
			m.note(t, "Impossibile leggere la chiave "+cfg.PrivateKeyPath+": "+err.Error())
		} else {
			var signer ssh.Signer
			if cfg.Passphrase != "" {
				signer, err = ssh.ParsePrivateKeyWithPassphrase(pem, []byte(cfg.Passphrase))
			} else {
				signer, err = ssh.ParsePrivateKey(pem)
			}
			if err != nil {
				m.note(t, "Chiave non valida: "+err.Error())
			} else {
				auths = append(auths, ssh.PublicKeys(signer))
			}
		}
	}
	if cfg.Password == "" && cfg.PrivateKeyPath == "" {
		if conn, err := dialAgent(); err == nil {
			closers = append(closers, conn)
			auths = append(auths, ssh.PublicKeysCallback(agent.NewClient(conn).Signers))
		}
	}
	if cfg.Password != "" {
		pw := cfg.Password
		auths = append(auths, ssh.Password(pw), ssh.KeyboardInteractive(func(_, _ string, qs []string, _ []bool) ([]string, error) {
			ans := make([]string, len(qs))
			for i := range ans {
				ans[i] = pw
			}
			return ans, nil
		}))
	}
	defer func() {
		for _, c := range closers {
			c.Close()
		}
	}()

	conf := &ssh.ClientConfig{User: username, Auth: auths, HostKeyCallback: m.hostKeyCallback(t, cfg.Host, cfg.Port), Timeout: 20 * time.Second}
	client, err := ssh.Dial("tcp", addr, conf)
	if err != nil {
		st := "error"
		if strings.Contains(err.Error(), "unable to authenticate") || strings.Contains(err.Error(), "no supported methods") {
			st = "auth-failed"
		}
		m.setStatus(t, gen, st, err.Error())
		return
	}
	sess, err := client.NewSession()
	if err != nil {
		client.Close()
		m.setStatus(t, gen, "error", err.Error())
		return
	}
	modes := ssh.TerminalModes{ssh.ECHO: 1, ssh.TTY_OP_ISPEED: 14400, ssh.TTY_OP_OSPEED: 14400}
	if err := sess.RequestPty("xterm-256color", rows, cols, modes); err != nil {
		client.Close()
		m.setStatus(t, gen, "error", err.Error())
		return
	}
	_ = sess.Setenv("COLORTERM", "truecolor")
	stdin, _ := sess.StdinPipe()
	stdout, _ := sess.StdoutPipe()
	stderr, _ := sess.StderrPipe()
	if err := sess.Shell(); err != nil {
		client.Close()
		m.setStatus(t, gen, "error", err.Error())
		return
	}
	t.mu.Lock()
	t.client, t.session, t.stdin, t.sftp = client, sess, stdin, nil
	startup := t.startup
	t.mu.Unlock()
	m.setStatus(t, gen, "connected", "Connesso a "+cfg.Host)

	pump := func(r io.Reader) {
		buf := make([]byte, 32*1024)
		for {
			n, err := r.Read(buf)
			if n > 0 {
				m.onData(t, append([]byte(nil), buf[:n]...))
			}
			if err != nil {
				return
			}
		}
	}
	go pump(stdout)
	go pump(stderr)
	if startup != "" {
		go func() { time.Sleep(400 * time.Millisecond); _, _ = stdin.Write([]byte(startup + "\n")) }()
	}
	// keepalive
	done := make(chan struct{})
	go func() {
		tk := time.NewTicker(15 * time.Second)
		defer tk.Stop()
		fails := 0
		for {
			select {
			case <-done:
				return
			case <-tk.C:
				if _, _, err := client.SendRequest("keepalive@openssh.com", true, nil); err != nil {
					if fails++; fails >= 3 {
						client.Close()
						return
					}
				} else {
					fails = 0
				}
			}
		}
	}()
	_ = sess.Wait()
	close(done)
	client.Close()
	m.setStatus(t, gen, "closed", "Connessione chiusa")
}

func (m *Manager) Reconnect(id, password string, save bool) (map[string]any, error) {
	t, err := m.Get(id)
	if err != nil {
		return nil, err
	}
	if t.Kind == "local" {
		t.mu.Lock()
		old := t.pty
		t.pty = nil
		t.mu.Unlock()
		if old != nil {
			old.Close()
		}
		go m.spawnLocal(t)
		return t.describe(), nil
	}
	t.mu.Lock()
	if t.client != nil {
		t.client.Close()
	}
	t.mu.Unlock()
	var cfg *Session
	if t.SessionID != "" {
		if password != "" && save {
			m.store.SavePassword(t.SessionID, password)
		}
		s, ok := m.store.SessionSecrets(t.SessionID)
		if !ok {
			return nil, errors.New("sessione non trovata")
		}
		cfg = s
	} else {
		cfg = &Session{Host: t.Host, Port: t.Port, Username: t.Username, Password: t.quickPw}
	}
	if password != "" {
		cfg.Password = password
		if t.SessionID == "" {
			t.quickPw = password
		}
	}
	go m.connectSSH(t, cfg)
	return t.describe(), nil
}

func (m *Manager) Write(id string, data []byte) {
	t, err := m.Get(id)
	if err != nil {
		return
	}
	t.mu.Lock()
	stdin, p := t.stdin, t.pty
	t.mu.Unlock()
	if t.Kind == "local" && p != nil {
		_, _ = p.Write(data)
	} else if stdin != nil {
		_, _ = stdin.Write(data)
	}
}

func (m *Manager) Resize(id string, cols, rows int) {
	t, err := m.Get(id)
	if err != nil || cols <= 0 || rows <= 0 {
		return
	}
	t.mu.Lock()
	t.Cols, t.Rows = cols, rows
	sess, p := t.session, t.pty
	t.mu.Unlock()
	if t.Kind == "local" && p != nil {
		_ = p.Resize(cols, rows)
	} else if sess != nil {
		_ = sess.WindowChange(rows, cols)
	}
}

func (m *Manager) Close(id string) {
	m.mu.Lock()
	t, ok := m.terms[id]
	delete(m.terms, id)
	m.mu.Unlock()
	if !ok {
		return
	}
	t.mu.Lock()
	t.gen++
	client, p := t.client, t.pty
	t.mu.Unlock()
	if client != nil {
		client.Close()
	}
	if p != nil {
		p.Close()
	}
}

func (m *Manager) CloseAll() {
	m.mu.Lock()
	ids := make([]string, 0, len(m.terms))
	for id := range m.terms {
		ids = append(ids, id)
	}
	m.mu.Unlock()
	for _, id := range ids {
		m.Close(id)
	}
}

// ------------------------------------------------------------------ funzioni per Claude

type limitedBuf struct {
	b   bytes.Buffer
	max int
}

func (l *limitedBuf) Write(p []byte) (int, error) {
	if l.b.Len() < l.max*2 {
		l.b.Write(p)
	}
	return len(p), nil
}

type ExecResult struct {
	ExitCode   *int   `json:"exitCode"`
	DurationMs int64  `json:"durationMs"`
	TimedOut   bool   `json:"timedOut"`
	Stdout     string `json:"stdout"`
	Stderr     string `json:"stderr"`
	Error      string `json:"error,omitempty"`
}

// Exec esegue un comando su un canale separato e ne restituisce l'output.
func (m *Manager) Exec(id, command string, timeout time.Duration, maxOut int) ExecResult {
	start := time.Now()
	res := ExecResult{}
	t, err := m.Get(id)
	if err != nil {
		res.Error = err.Error()
		return res
	}
	out, errb := &limitedBuf{max: maxOut}, &limitedBuf{max: maxOut}
	finish := func() ExecResult {
		res.DurationMs = time.Since(start).Milliseconds()
		res.Stdout = truncateMiddle(stripAnsi(out.b.String()), maxOut)
		res.Stderr = truncateMiddle(stripAnsi(errb.b.String()), maxOut/2)
		return res
	}
	code := func(c int) { res.ExitCode = &c }

	if t.Kind == "local" {
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()
		var cmd *exec.Cmd
		if goruntime.GOOS == "windows" {
			cmd = exec.CommandContext(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command)
		} else {
			sh := os.Getenv("SHELL")
			if sh == "" {
				sh = "/bin/bash"
			}
			cmd = exec.CommandContext(ctx, sh, "-lc", command)
		}
		cmd.Dir = t.Cwd
		cmd.Stdout, cmd.Stderr = out, errb
		hideWindow(cmd)
		err := cmd.Run()
		if ctx.Err() == context.DeadlineExceeded {
			res.TimedOut = true
		} else if ee, ok := err.(*exec.ExitError); ok {
			code(ee.ExitCode())
		} else if err != nil {
			res.Error = err.Error()
		} else {
			code(0)
		}
		return finish()
	}

	t.mu.Lock()
	client, status := t.client, t.Status
	t.mu.Unlock()
	if client == nil || status != "connected" {
		res.Error = fmt.Sprintf("terminale %s non connesso (stato: %s)", id, status)
		return finish()
	}
	sess, err := client.NewSession()
	if err != nil {
		res.Error = err.Error()
		return finish()
	}
	defer sess.Close()
	sess.Stdout, sess.Stderr = out, errb
	if err := sess.Start(command); err != nil {
		res.Error = err.Error()
		return finish()
	}
	done := make(chan error, 1)
	go func() { done <- sess.Wait() }()
	select {
	case err := <-done:
		var ee *ssh.ExitError
		var missing *ssh.ExitMissingError
		switch {
		case err == nil:
			code(0)
		case errors.As(err, &ee):
			code(ee.ExitStatus())
		case errors.As(err, &missing):
		default:
			res.Error = err.Error()
		}
	case <-time.After(timeout):
		_ = sess.Signal(ssh.SIGKILL)
		res.TimedOut = true
	}
	return finish()
}

// SendAndCapture scrive nella shell visibile e raccoglie l'output finché il terminale resta inattivo.
func (m *Manager) SendAndCapture(id, text string, enter bool, maxWait, idle time.Duration) (string, int64, error) {
	t, err := m.Get(id)
	if err != nil {
		return "", 0, err
	}
	t.mu.Lock()
	st := t.Status
	t.mu.Unlock()
	if st != "connected" {
		return "", 0, fmt.Errorf("terminale %s non connesso (stato: %s)", id, st)
	}
	var mu sync.Mutex
	var out bytes.Buffer
	activity := make(chan struct{}, 1)
	t.mu.Lock()
	t.nextL++
	key := t.nextL
	t.listeners[key] = func(d []byte) {
		mu.Lock()
		out.Write(d)
		mu.Unlock()
		select {
		case activity <- struct{}{}:
		default:
		}
	}
	t.mu.Unlock()
	defer func() { t.mu.Lock(); delete(t.listeners, key); t.mu.Unlock() }()

	start := time.Now()
	if enter {
		text += "\r"
	}
	m.Write(id, []byte(text))
	deadline := time.After(maxWait)
	idleT := time.NewTimer(max(idle, 2*time.Second))
	defer idleT.Stop()
loop:
	for {
		select {
		case <-activity:
			idleT.Reset(idle)
		case <-idleT.C:
			break loop
		case <-deadline:
			break loop
		}
	}
	mu.Lock()
	defer mu.Unlock()
	return truncateMiddle(stripAnsi(out.String()), 40000), time.Since(start).Milliseconds(), nil
}

func (m *Manager) RecentOutput(id string, lines int) string {
	t, err := m.Get(id)
	if err != nil {
		return ""
	}
	t.mu.Lock()
	s := stripAnsi(string(t.buffer))
	t.mu.Unlock()
	all := strings.Split(s, "\n")
	if len(all) > lines {
		all = all[len(all)-lines:]
	}
	return strings.Join(all, "\n")
}

// ------------------------------------------------------------------ SFTP

func (m *Manager) sftpClient(id string) (*sftp.Client, error) {
	t, err := m.Get(id)
	if err != nil {
		return nil, err
	}
	if t.Kind != "ssh" {
		return nil, errors.New("SFTP disponibile solo per sessioni SSH")
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.Status != "connected" || t.client == nil {
		return nil, errors.New("sessione non connessa")
	}
	if t.sftp != nil {
		return t.sftp, nil
	}
	c, err := sftp.NewClient(t.client, sftp.UseConcurrentWrites(true))
	if err != nil {
		return nil, err
	}
	t.sftp = c
	return c, nil
}

type FileEntry struct {
	Name      string `json:"name"`
	Type      string `json:"type"`
	Size      int64  `json:"size"`
	Mtime     int64  `json:"mtime"`
	Mode      uint32 `json:"mode"`
	LinkToDir bool   `json:"linkToDir,omitempty"`
	Longname  string `json:"longname"`
}

func (m *Manager) SftpList(id, dir string) (map[string]any, error) {
	c, err := m.sftpClient(id)
	if err != nil {
		return nil, err
	}
	if dir == "" || dir == "." {
		if dir, err = c.Getwd(); err != nil {
			dir = "/"
		}
	}
	real, err := c.RealPath(dir)
	if err != nil {
		return nil, err
	}
	list, err := c.ReadDir(real)
	if err != nil {
		return nil, err
	}
	entries := make([]FileEntry, 0, len(list))
	for _, fi := range list {
		e := FileEntry{Name: fi.Name(), Type: "file", Size: fi.Size(), Mtime: fi.ModTime().UnixMilli(), Mode: uint32(fi.Mode().Perm()),
			Longname: fmt.Sprintf("%s  %d  %s", fi.Mode().String(), fi.Size(), fi.ModTime().Format("2006-01-02 15:04"))}
		switch {
		case fi.IsDir():
			e.Type = "dir"
		case fi.Mode()&os.ModeSymlink != 0:
			e.Type = "link"
			if st, err := c.Stat(path.Join(real, fi.Name())); err == nil && st.IsDir() {
				e.LinkToDir = true
			}
		}
		entries = append(entries, e)
	}
	sort.Slice(entries, func(i, j int) bool {
		a, b := entries[i], entries[j]
		ad, bd := a.Type == "dir" || a.LinkToDir, b.Type == "dir" || b.LinkToDir
		if ad != bd {
			return ad
		}
		return strings.ToLower(a.Name) < strings.ToLower(b.Name)
	})
	return map[string]any{"path": real, "entries": entries}, nil
}

type progressWriter struct {
	w     io.Writer
	done  int64
	total int64
	cb    func(done, total int64)
}

func (p *progressWriter) Write(b []byte) (int, error) {
	n, err := p.w.Write(b)
	p.done += int64(n)
	if p.cb != nil {
		p.cb(p.done, p.total)
	}
	return n, err
}

func (m *Manager) SftpDownload(id, remote, local string, cb func(done, total int64)) error {
	c, err := m.sftpClient(id)
	if err != nil {
		return err
	}
	src, err := c.Open(remote)
	if err != nil {
		return err
	}
	defer src.Close()
	st, _ := src.Stat()
	dst, err := os.Create(local)
	if err != nil {
		return err
	}
	defer dst.Close()
	var total int64
	if st != nil {
		total = st.Size()
	}
	_, err = io.Copy(&progressWriter{w: dst, total: total, cb: cb}, src)
	return err
}

func (m *Manager) SftpUpload(id, local, remoteDir string, cb func(done, total int64)) (string, error) {
	c, err := m.sftpClient(id)
	if err != nil {
		return "", err
	}
	src, err := os.Open(local)
	if err != nil {
		return "", err
	}
	defer src.Close()
	st, _ := src.Stat()
	remote := path.Join(remoteDir, filepath.Base(local))
	dst, err := c.Create(remote)
	if err != nil {
		return "", err
	}
	defer dst.Close()
	_, err = io.Copy(&progressWriter{w: dst, total: st.Size(), cb: cb}, src)
	return remote, err
}

func (m *Manager) SftpMkdir(id, p string) error {
	c, err := m.sftpClient(id)
	if err != nil {
		return err
	}
	return c.Mkdir(p)
}

func (m *Manager) SftpRename(id, a, b string) error {
	c, err := m.sftpClient(id)
	if err != nil {
		return err
	}
	return c.Rename(a, b)
}

func (m *Manager) SftpDelete(id, p string, isDir bool) error {
	c, err := m.sftpClient(id)
	if err != nil {
		return err
	}
	if !isDir {
		return c.Remove(p)
	}
	return c.RemoveAll(p)
}

func (m *Manager) SftpReadFile(id, p string, maxBytes int64) (string, bool, error) {
	c, err := m.sftpClient(id)
	if err != nil {
		return "", false, err
	}
	f, err := c.Open(p)
	if err != nil {
		return "", false, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, maxBytes+1))
	if err != nil {
		return "", false, err
	}
	trunc := int64(len(b)) > maxBytes
	if trunc {
		b = b[:maxBytes]
	}
	return string(b), trunc, nil
}

func (m *Manager) SftpWriteFile(id, p, content string) error {
	c, err := m.sftpClient(id)
	if err != nil {
		return err
	}
	f, err := c.Create(p)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.Write([]byte(content))
	return err
}
