# NovaTerm

Client SSH/terminale desktop ispirato a MobaXterm, con interfaccia moderna, **import CSV** di host e password e **Claude Code integrato**, che esegue comandi direttamente sulle tue sessioni.

Stack: Electron · xterm.js · ssh2 · node-pty · Claude Agent SDK.

## Funzionalità

**Terminale e sessioni**
- Sessioni SSH (password, chiave privata con passphrase, ssh-agent, keyboard-interactive) e terminali locali, in schede
- Albero delle sessioni con gruppi, ricerca, colori, selezione multipla, "connetti tutto il gruppo"
- Connessione rapida `utente@host:porta` (Ctrl+K)
- Browser **SFTP** laterale che segue la scheda attiva: navigazione, download, upload (anche drag & drop), rinomina, elimina, nuova cartella, "cd qui"
- **Multi-esecuzione**: digiti una volta, il testo va a tutte le schede selezionate
- Ricerca nel terminale, copia alla selezione, incolla col tasto centrale, link cliccabili (Ctrl+clic), riconnessione con un clic
- Verifica delle host key (TOFU + avviso se la chiave cambia)
- Tema scuro/chiaro, 5 colori d'accento, 4 temi per il terminale

**Import / export CSV**
- Separatore `,` `;` o TAB rilevato in automatico; intestazioni in italiano o inglese
- Colonne: `name, group, host, port, username, password, private_key, passphrase, notes, type`
  (alias: nome, gruppo/cartella, hostname/ip/indirizzo, porta, utente/user/login, pass/pwd, chiave…)
- La colonna host accetta anche `utente@host:porta`
- Anteprima con selezione delle righe, rilevamento dei duplicati ed errori per riga
- Export con o senza password; modello CSV scaricabile
- Le password vengono cifrate con `safeStorage` di Electron (Portachiavi macOS, DPAPI su Windows, libsecret/kwallet su Linux)

```csv
name,group,host,port,username,password,private_key,notes
Web 1,Produzione,192.168.1.10,22,root,SuperSegreta!,,Server nginx
DB principale,Produzione,db.example.com,2222,admin,,~/.ssh/id_ed25519,PostgreSQL
Raspberry,Casa,pi@raspberrypi.local:22,,,raspberry,,
```

**Claude Code integrato** (pannello a destra, Ctrl+Shift+K)

Claude riceve un server MCP interno con questi strumenti sui terminali aperti:

| Strumento | Cosa fa | Conferma |
|---|---|---|
| `list_terminals` | elenca le schede aperte e quella attiva | no |
| `run_command` | esegue un comando su un canale SSH separato e restituisce stdout/stderr/exit code | sì |
| `run_command_multi` | stesso comando su più server in parallelo | sì |
| `send_to_terminal` | digita nella shell visibile e legge l'output (per `cd`, `sudo`, programmi interattivi) | sì |
| `read_terminal` | legge lo schermo di una scheda | no |
| `read_remote_file` / `write_remote_file` | legge e scrive file via SFTP | lettura no, scrittura sì |
| `list_saved_sessions` / `open_session` | trova e apre sessioni salvate (Claude non vede mai le password) | apertura sì |

- Ogni azione che modifica qualcosa mostra una scheda di approvazione con il **comando modificabile**, i server di destinazione e un avviso per i comandi pericolosi (`rm -rf`, `reboot`, `mkfs`…). Puoi scegliere Esegui (Ctrl+Invio), Consenti sempre (per la conversazione) o Rifiuta.
- Auto-approvazione opzionale (icona scudo) solo per i comandi sui terminali.
- Gli strumenti standard di Claude Code (Bash, Read, Edit, WebFetch…) restano disponibili sul computer locale, sempre con conferma; si possono disattivare dalle impostazioni.
- Dal menu del terminale: "Chiedi a Claude sulla selezione", "Spiega l'output con Claude". Dal menu SFTP: "Analizza con Claude".
- I blocchi di codice nelle risposte hanno "Copia" e "Al terminale" (incolla senza premere Invio).
- Modello predefinito: Claude Opus 5.5. Modello ed effort si cambiano in Impostazioni → Claude Code.

## Requisiti

- Node.js 18 o superiore (consigliato 22)
- Su Linux, per compilare `node-pty` se non c'è un binario precompilato: `build-essential` e `python3`
- Accesso a Claude: un login a Claude Code già fatto (`claude`, poi `/login`) **oppure** una API key Anthropic da inserire in Impostazioni → Claude Code

## Avvio

```bash
npm install
```

```bash
npm start
```

## Creare l'installer

```bash
npm install --save-dev electron-builder
```

```bash
npm run dist
```

Produce NSIS (Windows), DMG (macOS) o AppImage/deb (Linux) in `dist/`.

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
src/main/main.js        finestra Electron, IPC, dialoghi
src/main/terminals.js   SSH (ssh2), terminale locale (node-pty), SFTP, exec per Claude
src/main/claude.js      Claude Agent SDK, strumenti MCP, permessi
src/main/store.js       sessioni, impostazioni, host key, cifratura
src/main/csv.js         parsing ed export CSV
src/renderer/           interfaccia (HTML/CSS/JS, nessun bundler)
```

I dati si trovano nella cartella utente di Electron: `~/.config/NovaTerm` su Linux, `~/Library/Application Support/NovaTerm` su macOS, `%APPDATA%\NovaTerm` su Windows.

## Non ancora implementato

Rispetto a MobaXterm mancano: server X11, RDP/VNC, tunnel SSH e jump host, split dello schermo nella stessa scheda, macro.
