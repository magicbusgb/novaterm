# NovaTerm

Client SSH/terminale desktop ispirato a MobaXterm, scritto in **Go**, con interfaccia moderna, **import CSV** di host e password e **Claude Code integrato**, che esegue comandi direttamente sulle tue sessioni.

È un **unico eseguibile** (`NovaTerm.exe` su Windows, circa 14 MB): non servono Node.js, npm o un'installazione. L'interfaccia usa WebView2, già presente in Windows 10 e 11.

Stack: Go · [Wails](https://wails.io) · golang.org/x/crypto/ssh · pkg/sftp · ConPTY / creack/pty · xterm.js.

## Download e avvio

1. Scarica `NovaTerm.exe` dalla pagina **Releases** del repository (o dagli artefatti dell'azione *Build*).
2. Fai doppio clic. Al primo avvio Windows SmartScreen può avvisare che l'app non è firmata: *Ulteriori informazioni → Esegui comunque*.

I dati vengono salvati in `%APPDATA%\NovaTerm` (Windows), `~/Library/Application Support/NovaTerm` (macOS) e `~/.config/NovaTerm` (Linux).

## Funzionalità

**Terminale e sessioni**
- Sessioni SSH (password, chiave privata con passphrase, ssh-agent / agent OpenSSH di Windows, keyboard-interactive) e terminali locali (PowerShell su Windows), in schede
- Albero delle sessioni con gruppi, ricerca, colori, selezione multipla, "connetti tutto il gruppo"
- Connessione rapida `utente@host:porta` (Ctrl+K)
- Browser **SFTP** laterale che segue la scheda attiva: navigazione, download, upload (anche drag & drop), rinomina, elimina, nuova cartella
- **Multi-esecuzione**: digiti una volta, il testo va a tutte le schede selezionate
- Ricerca nel terminale, copia alla selezione, incolla col tasto centrale, riconnessione con un clic
- Verifica delle host key (salvate al primo collegamento, avviso se cambiano)
- Tema scuro/chiaro, 5 colori d'accento, 4 temi per il terminale

**Import / export CSV**
- Separatore `,` `;` o TAB rilevato in automatico; intestazioni in italiano o inglese
- Colonne: `name, group, host, port, username, password, private_key, passphrase, notes, type`
  (alias: nome, gruppo/cartella, hostname/ip/indirizzo, porta, utente/user/login, pass/pwd, chiave…)
- La colonna host accetta anche `utente@host:porta`
- Anteprima con selezione delle righe, duplicati ed errori per riga; export con o senza password
- Le password sono cifrate con AES-256-GCM. La chiave è custodita nel portachiavi di sistema: Gestione credenziali su Windows, Portachiavi su macOS, Secret Service su Linux

```csv
name,group,host,port,username,password,private_key,notes
Web 1,Produzione,192.168.1.10,22,root,SuperSegreta!,,Server nginx
DB principale,Produzione,db.example.com,2222,admin,,~/.ssh/id_ed25519,PostgreSQL
Raspberry,Casa,pi@raspberrypi.local:22,,,raspberry,,
```

**Claude Code integrato** (pannello a destra, Ctrl+Shift+K)

NovaTerm avvia il `claude` che hai installato e gli fornisce un server MCP locale, raggiungibile solo da `127.0.0.1` e protetto da un token. Il server offre questi strumenti sui terminali aperti:

| Strumento | Cosa fa | Conferma |
|---|---|---|
| `list_terminals` | elenca le schede aperte e quella attiva | no |
| `run_command` | esegue un comando su un canale SSH separato e restituisce stdout/stderr/exit code | sì |
| `run_command_multi` | stesso comando su più server in parallelo | sì |
| `send_to_terminal` | digita nella shell visibile e legge l'output (`cd`, `sudo`, programmi interattivi) | sì |
| `read_terminal` | legge lo schermo di una scheda | no |
| `read_remote_file` / `write_remote_file` | legge e scrive file via SFTP | lettura no, scrittura sì |
| `list_saved_sessions` / `open_session` | trova e apre sessioni salvate (Claude non vede mai le password) | apertura sì |

- La conferma avviene dentro NovaTerm, nello strumento stesso: mostra il **comando modificabile**, i server coinvolti e un avviso per i comandi pericolosi. Puoi scegliere Esegui (Ctrl+Invio), Consenti sempre o Rifiuta.
- Gli strumenti standard di Claude Code (Bash, Edit, Web…) agiscono sul tuo computer e chiedono conferma nello stesso pannello quando Claude Code lo richiede. Si possono disattivare dalle impostazioni.
- Auto-approvazione opzionale (icona scudo) per i soli comandi sui terminali.

**Requisito per Claude:** Claude Code installato e con login già fatto. Per installarlo segui https://claude.com/claude-code, poi esegui `claude` una volta e completa il login. In alternativa inserisci una API key in Impostazioni → Claude Code. Se `claude` non è nel PATH, indica il percorso nelle impostazioni.

## Compilare dai sorgenti

Servono Go 1.24 o superiore e la CLI di Wails:

```bash
go install github.com/wailsapp/wails/v2/cmd/wails@v2.17.1
```

Eseguibile Windows (si può compilare anche da Linux o macOS):

```bash
wails build -platform windows/amd64 -skipbindings -trimpath -ldflags "-s -w"
```

Il file risultante è `build/bin/NovaTerm.exe`. Per macOS usa `-platform darwin/universal`; per Linux `-platform linux/amd64`, che richiede `libgtk-3-dev` e `libwebkit2gtk-4.0-dev`.

L'azione GitHub **Build** (`.github/workflows/build.yml`) compila le tre piattaforme. Parte a mano (*Actions → Build → Run workflow*) oppure quando pubblichi un tag `v*`, e in quel caso allega gli eseguibili alla release.

## Scorciatoie

| Azione | Tasti |
|---|---|
| Connessione rapida | Ctrl+K |
| Terminale locale | Ctrl+Shift+T |
| Nuova sessione | Ctrl+Shift+N |
| Chiudi scheda | Ctrl+Shift+W |
| Scheda successiva / precedente | Ctrl+Tab / Ctrl+Shift+Tab |
| Vai alla scheda N | Ctrl+1…9 |
| Cerca nel terminale | Ctrl+Shift+F |
| Copia / Incolla | Ctrl+Shift+C / Ctrl+Shift+V |
| Pannello Claude | Ctrl+Shift+K |
| Zoom carattere | Ctrl+= / Ctrl+- / Ctrl+0 |

## Struttura

```
main.go               avvio Wails, finestra, dialoghi nativi
app.go                ponte con l'interfaccia (Invoke, eventi, richieste)
terminal.go           SSH, terminale locale, SFTP, esecuzione comandi per Claude
platform_*.go         ConPTY (Windows) / pty (macOS, Linux), ssh-agent
claude.go, tools.go   processo Claude Code, server MCP, strumenti, approvazioni
store.go, csv.go      sessioni, impostazioni, cifratura, CSV
frontend/             interfaccia (HTML/CSS/JS, xterm.js incluso in vendor/)
devweb.go             modalità di test via browser (solo con -tags devweb)
```

## Non ancora implementato

Rispetto a MobaXterm mancano: server X11, RDP/VNC, tunnel SSH e jump host, split dello schermo nella stessa scheda, macro.
