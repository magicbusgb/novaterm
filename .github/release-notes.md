Prima versione in Go: NovaTerm è ora un **unico eseguibile**, senza Node.js né installazione.

### Download
- **Windows 10/11 (64 bit):** `NovaTerm-windows-amd64.exe` → doppio clic. Se SmartScreen avvisa che l'app non è firmata: *Ulteriori informazioni → Esegui comunque*.
- **macOS:** `NovaTerm-macos.zip` (app universale Intel/Apple Silicon, non firmata: al primo avvio clic destro → Apri).
- **Linux:** `NovaTerm-linux-amd64` (richiede GTK3 e WebKit2GTK).

### Novità
- Backend riscritto in Go (Wails): SSH, SFTP, terminale locale (PowerShell/ConPTY su Windows)
- Import/export CSV di host e password; password cifrate con AES-256-GCM e chiave in Gestione credenziali di Windows
- Claude Code integrato: esegue comandi sulle sessioni aperte, con conferma di ogni azione dentro NovaTerm

### Requisito per Claude
Claude Code installato con login già fatto (`claude`, poi `/login`), oppure una API key in Impostazioni → Claude Code.
