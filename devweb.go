//go:build devweb

package main

// Modalità di test: serve l'interfaccia via HTTP + WebSocket invece che in Wails,
// così si può pilotarla con un browser automatizzato. Non è inclusa nelle build normali.

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"

	"github.com/gorilla/websocket"
)

type wsTransport struct {
	mu   sync.Mutex
	conn *websocket.Conn
	clip string
}

func (w *wsTransport) send(v any) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.conn != nil {
		_ = w.conn.WriteJSON(v)
	}
}
func (w *wsTransport) Emit(name string, args ...any) {
	w.send(map[string]any{"t": "event", "name": name, "args": args})
}
func (w *wsTransport) OpenURL(url string)            { log.Println("open url", url) }
func (w *wsTransport) ClipboardGet() (string, error) { return w.clip, nil }
func (w *wsTransport) ClipboardSet(t string) error   { w.clip = t; return nil }

// Dialoghi finti: restituiscono percorsi dalle variabili d'ambiente NOVA_PICK / NOVA_SAVE.
type envDialogs struct{}

func (envDialogs) OpenFile(string, []FileFilter) (string, error) { return pick("NOVA_PICK") }
func (envDialogs) OpenFiles(string) ([]string, error) {
	p, err := pick("NOVA_PICK")
	if p == "" {
		return nil, err
	}
	return strings.Split(p, string(os.PathListSeparator)), err
}
func (envDialogs) OpenDir(string) (string, error) { return pick("NOVA_PICK_DIR") }
func (envDialogs) SaveFile(_, _, name string, _ []FileFilter) (string, error) {
	d, err := pick("NOVA_SAVE_DIR")
	if d == "" {
		return "", err
	}
	return d + "/" + name, nil
}
func pick(env string) (string, error) {
	if v := os.Getenv(env); v != "" {
		return v, nil
	}
	return "", errors.New("dialogo non disponibile in modalità test")
}

func runDevWeb() bool {
	addr := os.Getenv("NOVA_DEVWEB")
	if addr == "" {
		return false
	}
	app := NewApp()
	tr := &wsTransport{}
	app.attach(tr, envDialogs{})
	up := websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}
	mux := http.NewServeMux()
	mux.Handle("/", http.FileServer(http.FS(frontendFS())))
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		tr.mu.Lock()
		tr.conn = c
		tr.mu.Unlock()
		for {
			var m struct {
				T       string            `json:"t"`
				ID      int               `json:"id"`
				Channel string            `json:"channel"`
				Args    []json.RawMessage `json:"args"`
				Term    string            `json:"term"`
				Data    string            `json:"data"`
				Cols    int               `json:"cols"`
				Rows    int               `json:"rows"`
				ReqID   string            `json:"reqId"`
				Result  any               `json:"result"`
			}
			if err := c.ReadJSON(&m); err != nil {
				return
			}
			switch m.T {
			case "invoke":
				go func(id int, ch string, args []json.RawMessage) {
					data, err := app.Invoke(ch, args)
					res := map[string]any{"t": "res", "id": id, "ok": err == nil, "data": data}
					if err != nil {
						res["error"] = err.Error()
					}
					tr.send(res)
				}(m.ID, m.Channel, m.Args)
			case "write":
				app.Write(m.Term, m.Data)
			case "resize":
				app.Resize(m.Term, m.Cols, m.Rows)
			case "active":
				app.SetActive(m.Term)
			case "respond":
				app.Respond(m.ReqID, m.Result)
			}
		}
	})
	fmt.Println("NovaTerm devweb su http://" + addr)
	log.Fatal(http.ListenAndServe(addr, mux))
	return true
}
