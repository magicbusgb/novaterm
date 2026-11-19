package main

import (
	"bytes"
	"encoding/csv"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"
)

var csvAliases = map[string][]string{
	"name":           {"name", "nome", "session", "sessione", "label", "etichetta", "title", "titolo"},
	"host":           {"host", "hostname", "ip", "address", "indirizzo", "server", "remote_host", "remotehost"},
	"port":           {"port", "porta", "ssh_port"},
	"username":       {"username", "user", "utente", "login", "user_name", "nomeutente"},
	"password":       {"password", "pass", "pwd", "passwd", "secret"},
	"group":          {"group", "gruppo", "folder", "cartella", "category", "categoria", "tag", "env", "environment"},
	"type":           {"type", "tipo", "protocol", "protocollo"},
	"privateKeyPath": {"key", "private_key", "privatekey", "key_path", "keyfile", "identity", "chiave", "identity_file"},
	"passphrase":     {"passphrase", "key_passphrase"},
	"notes":          {"notes", "note", "description", "descrizione", "comment", "commento"},
	"startupCommand": {"startup", "startup_command", "command", "comando", "comando_avvio"},
}

var headerNorm = regexp.MustCompile(`[\s-]+`)

func canonicalHeader(h string) string {
	h = headerNorm.ReplaceAllString(strings.ToLower(strings.TrimSpace(h)), "_")
	for key, list := range csvAliases {
		for _, a := range list {
			if a == h {
				return key
			}
		}
	}
	return ""
}

type CSVError struct {
	Line    int    `json:"line"`
	Message string `json:"message"`
}

type CSVResult struct {
	Rows    []map[string]string
	Errors  []CSVError
	Mapping map[string]string
	Unknown []string
}

// detectDelimiter sceglie tra , ; e TAB contando le occorrenze nella prima riga (fuori dalle virgolette).
func detectDelimiter(data []byte) rune {
	line := data
	if i := bytes.IndexByte(data, '\n'); i >= 0 {
		line = data[:i]
	}
	counts := map[rune]int{',': 0, ';': 0, '\t': 0}
	inQ := false
	for _, r := range string(line) {
		if r == '"' {
			inQ = !inQ
		} else if !inQ {
			if _, ok := counts[r]; ok {
				counts[r]++
			}
		}
	}
	best, max := ',', -1
	for _, r := range []rune{',', ';', '\t'} {
		if counts[r] > max {
			best, max = r, counts[r]
		}
	}
	return best
}

var hostPortRe = regexp.MustCompile(`^\[?([^\]]+?)\]?:(\d+)$`)

func ParseCSV(data []byte) CSVResult {
	data = bytes.TrimPrefix(data, []byte("\xef\xbb\xbf"))
	res := CSVResult{Mapping: map[string]string{}}
	r := csv.NewReader(bytes.NewReader(data))
	r.Comma = detectDelimiter(data)
	r.FieldsPerRecord = -1
	r.LazyQuotes = true
	header, err := r.Read()
	if err != nil {
		res.Errors = append(res.Errors, CSVError{1, "file vuoto o non leggibile"})
		return res
	}
	cols := make([]string, len(header))
	used := map[string]bool{}
	for i, h := range header {
		c := canonicalHeader(h)
		if c != "" && !used[c] {
			cols[i] = c
			used[c] = true
			res.Mapping[strings.TrimSpace(h)] = c
		} else if strings.TrimSpace(h) != "" {
			res.Unknown = append(res.Unknown, strings.TrimSpace(h))
		}
	}
	line := 1
	for {
		rec, err := r.Read()
		if err == io.EOF {
			break
		}
		line++
		if err != nil {
			res.Errors = append(res.Errors, CSVError{line, err.Error()})
			continue
		}
		row := map[string]string{}
		empty := true
		for i, v := range rec {
			if i >= len(cols) || cols[i] == "" {
				continue
			}
			if strings.TrimSpace(v) != "" {
				empty = false
				if cols[i] == "password" || cols[i] == "passphrase" {
					row[cols[i]] = v
				} else {
					row[cols[i]] = strings.TrimSpace(v)
				}
			}
		}
		if empty {
			continue
		}
		// host nel formato utente@host:porta
		host := row["host"]
		if at := strings.Index(host, "@"); at >= 0 && row["username"] == "" {
			row["username"], host = host[:at], host[at+1:]
		}
		if m := hostPortRe.FindStringSubmatch(host); m != nil && strings.Count(host, ":") == 1 {
			host = m[1]
			if row["port"] == "" {
				row["port"] = m[2]
			}
		}
		row["host"] = strings.TrimSpace(host)
		typ := strings.ToLower(row["type"])
		if typ == "local" || typ == "locale" {
			row["type"] = "local"
		} else {
			row["type"] = "ssh"
		}
		if row["type"] != "local" && row["host"] == "" {
			res.Errors = append(res.Errors, CSVError{line, "host mancante"})
			continue
		}
		if p := row["port"]; p != "" {
			if n, err := strconv.Atoi(p); err != nil || n < 1 || n > 65535 {
				res.Errors = append(res.Errors, CSVError{line, fmt.Sprintf("porta non valida: %s", p)})
				continue
			}
		}
		res.Rows = append(res.Rows, row)
	}
	return res
}

func ExportCSV(list []*Session, includePasswords bool) ([]byte, error) {
	var buf bytes.Buffer
	buf.WriteString("\xef\xbb\xbf") // BOM: Excel apre correttamente gli accenti
	w := csv.NewWriter(&buf)
	head := []string{"name", "group", "type", "host", "port", "username"}
	if includePasswords {
		head = append(head, "password")
	}
	head = append(head, "private_key", "notes")
	_ = w.Write(head)
	for _, s := range list {
		rec := []string{s.Name, s.Group, s.Type, s.Host, strconv.Itoa(s.Port), s.Username}
		if includePasswords {
			rec = append(rec, s.Password)
		}
		rec = append(rec, s.PrivateKeyPath, s.Notes)
		_ = w.Write(rec)
	}
	w.Flush()
	return buf.Bytes(), w.Error()
}

const csvTemplate = "name,group,host,port,username,password,private_key,notes\r\n" +
	"Web 1,Produzione,192.168.1.10,22,root,SuperSegreta!,,Server nginx\r\n" +
	"DB principale,Produzione,db.example.com,2222,admin,,~/.ssh/id_ed25519,PostgreSQL\r\n" +
	"Raspberry,Casa,pi@raspberrypi.local:22,,,raspberry,,\r\n"
