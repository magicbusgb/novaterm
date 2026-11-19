package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/zalando/go-keyring"
)

// Session è una connessione salvata. Password e passphrase sono cifrate ("enc:..").
type Session struct {
	ID             string `json:"id"`
	Type           string `json:"type"`
	Name           string `json:"name"`
	Host           string `json:"host"`
	Port           int    `json:"port"`
	Username       string `json:"username"`
	Group          string `json:"group"`
	PrivateKeyPath string `json:"privateKeyPath"`
	Notes          string `json:"notes"`
	Color          string `json:"color"`
	StartupCommand string `json:"startupCommand"`
	Password       string `json:"password,omitempty"`
	Passphrase     string `json:"passphrase,omitempty"`
	CreatedAt      int64  `json:"createdAt"`
	LastUsed       int64  `json:"lastUsed"`
}

type Settings struct {
	Theme             string `json:"theme"`
	Accent            string `json:"accent"`
	TerminalTheme     string `json:"terminalTheme"`
	FontSize          int    `json:"fontSize"`
	FontFamily        string `json:"fontFamily"`
	CursorStyle       string `json:"cursorStyle"`
	Scrollback        int    `json:"scrollback"`
	CopyOnSelect      bool   `json:"copyOnSelect"`
	LocalShell        string `json:"localShell"`
	ClaudeModel       string `json:"claudeModel"`
	ClaudeEffort      string `json:"claudeEffort"`
	ClaudeAutoApprove bool   `json:"claudeAutoApprove"`
	ClaudeLocalTools  bool   `json:"claudeLocalTools"`
	ClaudePath        string `json:"claudePath"`
	ClaudeWorkdir     string `json:"claudeWorkdir"`
	ClaudeAPIKey      string `json:"claudeApiKey"`
	SidebarWidth      int    `json:"sidebarWidth"`
	ClaudeWidth       int    `json:"claudeWidth"`
	ClaudeOpen        bool   `json:"claudeOpen"`
}

func defaultSettings() Settings {
	return Settings{
		Theme: "dark", Accent: "violet", TerminalTheme: "nova", FontSize: 14,
		FontFamily:  `"JetBrains Mono", "Cascadia Code", "Cascadia Mono", "Fira Code", Menlo, Consolas, "DejaVu Sans Mono", monospace`,
		CursorStyle: "bar", Scrollback: 10000, CopyOnSelect: true,
		ClaudeModel: "claude-opus-5-5", ClaudeEffort: "high", ClaudeLocalTools: true,
		SidebarWidth: 280, ClaudeWidth: 420, ClaudeOpen: true,
	}
}

func (s Settings) toMap() map[string]any {
	b, _ := json.Marshal(s)
	m := map[string]any{}
	_ = json.Unmarshal(b, &m)
	return m
}

type Store struct {
	mu         sync.Mutex
	dir        string
	sessions   []*Session
	settings   Settings
	knownHosts map[string]string
	key        []byte
	keyringOK  bool
}

const keyringService = "NovaTerm"

func NewStore() *Store {
	base, err := os.UserConfigDir()
	if err != nil {
		base, _ = os.UserHomeDir()
	}
	dir := filepath.Join(base, "NovaTerm")
	if d := os.Getenv("NOVATERM_DATA_DIR"); d != "" {
		dir = d
	}
	_ = os.MkdirAll(dir, 0o700)
	s := &Store{dir: dir, settings: defaultSettings(), knownHosts: map[string]string{}}
	s.readJSON("sessions.json", &s.sessions)
	s.readJSON("settings.json", &s.settings)
	s.readJSON("known_hosts.json", &s.knownHosts)
	s.loadKey()
	return s
}

func (s *Store) path(n string) string { return filepath.Join(s.dir, n) }

func (s *Store) readJSON(name string, v any) {
	b, err := os.ReadFile(s.path(name))
	if err == nil {
		_ = json.Unmarshal(b, v)
	}
}

func (s *Store) writeJSON(name string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path(name + ".tmp")
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path(name))
}

// ------------------------------------------------------------------ cifratura

// La chiave master AES-256 sta nel portachiavi del sistema (Credential Manager su Windows,
// Portachiavi su macOS, Secret Service su Linux). Se non disponibile, in un file locale 0600.
func (s *Store) loadKey() {
	if os.Getenv("NOVATERM_NO_KEYRING") == "" {
		if v, err := keyring.Get(keyringService, "master-key"); err == nil {
			if k, err := base64.StdEncoding.DecodeString(v); err == nil && len(k) == 32 {
				s.key, s.keyringOK = k, true
				return
			}
		}
	}
	keyFile := s.path("master.key")
	if b, err := os.ReadFile(keyFile); err == nil {
		if k, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(b))); err == nil && len(k) == 32 {
			s.key = k
			// prova a spostarla nel portachiavi
			if os.Getenv("NOVATERM_NO_KEYRING") == "" && keyring.Set(keyringService, "master-key", base64.StdEncoding.EncodeToString(k)) == nil {
				s.keyringOK = true
				_ = os.Remove(keyFile)
			}
			return
		}
	}
	k := make([]byte, 32)
	_, _ = rand.Read(k)
	s.key = k
	enc := base64.StdEncoding.EncodeToString(k)
	if os.Getenv("NOVATERM_NO_KEYRING") == "" && keyring.Set(keyringService, "master-key", enc) == nil {
		s.keyringOK = true
		return
	}
	_ = os.WriteFile(keyFile, []byte(enc), 0o600)
}

func (s *Store) KeyringOK() bool { return s.keyringOK }

func (s *Store) Encrypt(plain string) string {
	if plain == "" {
		return ""
	}
	block, _ := aes.NewCipher(s.key)
	gcm, _ := cipher.NewGCM(block)
	nonce := make([]byte, gcm.NonceSize())
	_, _ = rand.Read(nonce)
	return "enc:" + base64.StdEncoding.EncodeToString(gcm.Seal(nonce, nonce, []byte(plain), nil))
}

func (s *Store) Decrypt(v string) string {
	if !strings.HasPrefix(v, "enc:") {
		return ""
	}
	raw, err := base64.StdEncoding.DecodeString(v[4:])
	if err != nil {
		return ""
	}
	block, _ := aes.NewCipher(s.key)
	gcm, _ := cipher.NewGCM(block)
	if len(raw) < gcm.NonceSize() {
		return ""
	}
	out, err := gcm.Open(nil, raw[:gcm.NonceSize()], raw[gcm.NonceSize():], nil)
	if err != nil {
		return ""
	}
	return string(out)
}

// ------------------------------------------------------------------ sessioni

func (s *Store) public(x *Session) map[string]any {
	return map[string]any{
		"id": x.ID, "type": x.Type, "name": x.Name, "host": x.Host, "port": x.Port, "username": x.Username,
		"group": x.Group, "privateKeyPath": x.PrivateKeyPath, "notes": x.Notes, "color": x.Color,
		"startupCommand": x.StartupCommand, "createdAt": x.CreatedAt, "lastUsed": x.LastUsed,
		"hasPassword": x.Password != "", "hasPassphrase": x.Passphrase != "",
	}
}

func (s *Store) ListSessions() []map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]map[string]any, 0, len(s.sessions))
	for _, x := range s.sessions {
		out = append(out, s.public(x))
	}
	return out
}

func (s *Store) find(id string) *Session {
	for _, x := range s.sessions {
		if x.ID == id {
			return x
		}
	}
	return nil
}

// SessionSecrets restituisce una copia con password e passphrase in chiaro (solo uso interno).
func (s *Store) SessionSecrets(id string) (*Session, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	x := s.find(id)
	if x == nil {
		return nil, false
	}
	c := *x
	c.Password, c.Passphrase = s.Decrypt(x.Password), s.Decrypt(x.Passphrase)
	return &c, true
}

func (s *Store) SessionsWithSecrets(ids []string) []*Session {
	s.mu.Lock()
	all := s.sessions
	s.mu.Unlock()
	var out []*Session
	if len(ids) == 0 {
		for _, x := range all {
			ids = append(ids, x.ID)
		}
	}
	for _, id := range ids {
		if c, ok := s.SessionSecrets(id); ok {
			out = append(out, c)
		}
	}
	return out
}

func anyStr(v any) (string, bool) {
	switch t := v.(type) {
	case nil:
		return "", false
	case string:
		return t, true
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64), true
	case bool:
		return strconv.FormatBool(t), true
	}
	return fmt.Sprint(v), true
}

// apply aggiorna una sessione dai campi di input. Per password/passphrase: assente = invariata, "" = cancella.
func (s *Store) apply(x *Session, in map[string]any) {
	set := func(key string, dst *string) {
		if v, ok := anyStr(in[key]); ok {
			*dst = strings.TrimSpace(v)
		}
	}
	if v, ok := anyStr(in["type"]); ok {
		x.Type = "ssh"
		if strings.EqualFold(v, "local") {
			x.Type = "local"
		}
	}
	set("name", &x.Name)
	set("host", &x.Host)
	set("username", &x.Username)
	set("group", &x.Group)
	set("privateKeyPath", &x.PrivateKeyPath)
	set("color", &x.Color)
	if v, ok := anyStr(in["notes"]); ok {
		x.Notes = v
	}
	if v, ok := anyStr(in["startupCommand"]); ok {
		x.StartupCommand = v
	}
	if v, ok := anyStr(in["port"]); ok {
		if p, err := strconv.Atoi(strings.TrimSpace(v)); err == nil && p > 0 && p < 65536 {
			x.Port = p
		}
	}
	if v, ok := in["password"].(string); ok {
		x.Password = s.Encrypt(v)
	}
	if v, ok := in["passphrase"].(string); ok {
		x.Passphrase = s.Encrypt(v)
	}
	if x.Type == "" {
		x.Type = "ssh"
	}
	if x.Port == 0 {
		x.Port = 22
	}
	if x.Name == "" {
		switch {
		case x.Type == "local":
			x.Name = "Terminale locale"
		case x.Username != "":
			x.Name = x.Username + "@" + x.Host
		default:
			x.Name = x.Host
		}
	}
}

func (s *Store) SaveSession(in map[string]any) (map[string]any, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	id, _ := in["id"].(string)
	x := s.find(id)
	if x == nil {
		x = &Session{ID: uuid.NewString(), CreatedAt: time.Now().UnixMilli()}
		s.apply(x, in)
		if x.Type == "ssh" && x.Host == "" {
			return nil, errors.New("host mancante")
		}
		s.sessions = append(s.sessions, x)
	} else {
		s.apply(x, in)
	}
	return s.public(x), s.writeJSON("sessions.json", s.sessions)
}

func (s *Store) Duplicate(id string) (map[string]any, error) {
	s.mu.Lock()
	x := s.find(id)
	if x == nil {
		s.mu.Unlock()
		return nil, errors.New("sessione non trovata")
	}
	c := *x
	c.ID, c.Name, c.CreatedAt, c.LastUsed = uuid.NewString(), x.Name+" (copia)", time.Now().UnixMilli(), 0
	s.sessions = append(s.sessions, &c)
	err := s.writeJSON("sessions.json", s.sessions)
	s.mu.Unlock()
	return s.public(&c), err
}

// FindDuplicate: stesso tipo, host, porta, utente e nome.
func (s *Store) FindDuplicate(r map[string]string) *Session {
	port, _ := strconv.Atoi(r["port"])
	if port == 0 {
		port = 22
	}
	typ := r["type"]
	if typ == "" {
		typ = "ssh"
	}
	name := strings.ToLower(strings.TrimSpace(r["name"]))
	for _, x := range s.sessions {
		if x.Type == typ && x.Host == r["host"] && x.Port == port && x.Username == r["username"] && (name == "" || strings.ToLower(x.Name) == name) {
			return x
		}
	}
	return nil
}

func (s *Store) Import(rows []map[string]string, skipDup bool) (added, updated, skipped int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, r := range rows {
		in := map[string]any{}
		for k, v := range r {
			in[k] = v
		}
		if dup := s.FindDuplicate(r); dup != nil {
			if skipDup {
				skipped++
				continue
			}
			s.apply(dup, in)
			updated++
			continue
		}
		x := &Session{ID: uuid.NewString(), CreatedAt: time.Now().UnixMilli()}
		s.apply(x, in)
		s.sessions = append(s.sessions, x)
		added++
	}
	_ = s.writeJSON("sessions.json", s.sessions)
	return
}

func (s *Store) DeleteSessions(ids []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	del := map[string]bool{}
	for _, id := range ids {
		del[id] = true
	}
	out := s.sessions[:0]
	for _, x := range s.sessions {
		if !del[x.ID] {
			out = append(out, x)
		}
	}
	s.sessions = out
	_ = s.writeJSON("sessions.json", s.sessions)
}

func (s *Store) RenameGroup(old, nw string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, x := range s.sessions {
		if x.Group == old {
			x.Group = nw
		}
	}
	_ = s.writeJSON("sessions.json", s.sessions)
}

func (s *Store) Touch(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if x := s.find(id); x != nil {
		x.LastUsed = time.Now().UnixMilli()
		_ = s.writeJSON("sessions.json", s.sessions)
	}
}

func (s *Store) SavePassword(id, pw string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if x := s.find(id); x != nil {
		x.Password = s.Encrypt(pw)
		_ = s.writeJSON("sessions.json", s.sessions)
	}
}

func (s *Store) Groups() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	m := map[string]bool{}
	for _, x := range s.sessions {
		if x.Group != "" {
			m[x.Group] = true
		}
	}
	var out []string
	for g := range m {
		out = append(out, g)
	}
	sort.Strings(out)
	return out
}

// ------------------------------------------------------------------ impostazioni

func (s *Store) Settings() Settings {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.settings
}

func (s *Store) SetSettings(patch map[string]any) (Settings, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	m := s.settings.toMap()
	for k, v := range patch {
		m[k] = v
	}
	b, _ := json.Marshal(m)
	var ns Settings
	if err := json.Unmarshal(b, &ns); err != nil {
		return s.settings, err
	}
	s.settings = ns
	return ns, s.writeJSON("settings.json", ns)
}

// ------------------------------------------------------------------ host key

func (s *Store) HostKey(host string, port int) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.knownHosts[fmt.Sprintf("%s:%d", host, port)]
}

func (s *Store) SaveHostKey(host string, port int, fp string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.knownHosts[fmt.Sprintf("%s:%d", host, port)] = fp
	_ = s.writeJSON("known_hosts.json", s.knownHosts)
}
