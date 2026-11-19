/* Palette per xterm.js */
(function () {
  const THEMES = {
    nova: {
      label: 'Nova (scuro)', dark: true,
      background: '#0d1017', foreground: '#dfe3f0', cursor: '#a99cff', cursorAccent: '#0d1017',
      selectionBackground: 'rgba(139,124,246,0.35)',
      black: '#1b1f2c', red: '#ff6b81', green: '#3ddc97', yellow: '#ffd166', blue: '#6ea8fe', magenta: '#c49bff', cyan: '#5eead4', white: '#d4d8e8',
      brightBlack: '#5b6178', brightRed: '#ff8fa0', brightGreen: '#6ff0b5', brightYellow: '#ffe19a', brightBlue: '#9cc3ff', brightMagenta: '#dcc2ff', brightCyan: '#8ff5e2', brightWhite: '#ffffff',
    },
    midnight: {
      label: 'Midnight', dark: true,
      background: '#070910', foreground: '#c8d3f5', cursor: '#82aaff', cursorAccent: '#070910',
      selectionBackground: 'rgba(130,170,255,0.3)',
      black: '#1e2030', red: '#ff757f', green: '#c3e88d', yellow: '#ffc777', blue: '#82aaff', magenta: '#c099ff', cyan: '#86e1fc', white: '#c8d3f5',
      brightBlack: '#545c7e', brightRed: '#ff98a4', brightGreen: '#d4f2a8', brightYellow: '#ffdaa1', brightBlue: '#a7c4ff', brightMagenta: '#d6bcff', brightCyan: '#b4f0ff', brightWhite: '#ffffff',
    },
    ember: {
      label: 'Ember', dark: true,
      background: '#14110f', foreground: '#ebdbc7', cursor: '#fb923c', cursorAccent: '#14110f',
      selectionBackground: 'rgba(251,146,60,0.3)',
      black: '#2a2420', red: '#f2594b', green: '#a9b665', yellow: '#e9b143', blue: '#80aa9e', magenta: '#d3869b', cyan: '#8bba7f', white: '#e2cca9',
      brightBlack: '#6b5f55', brightRed: '#ff7a6b', brightGreen: '#c5d18a', brightYellow: '#f5ca6f', brightBlue: '#a3c9bf', brightMagenta: '#e6a5b6', brightCyan: '#aed5a3', brightWhite: '#fbf1c7',
    },
    paper: {
      label: 'Paper (chiaro)', dark: false,
      background: '#fbfbfd', foreground: '#2b2f40', cursor: '#6d5dfc', cursorAccent: '#fbfbfd',
      selectionBackground: 'rgba(109,93,252,0.22)',
      black: '#2b2f40', red: '#d1343f', green: '#13865c', yellow: '#a86600', blue: '#2f62d9', magenta: '#8a3fd1', cyan: '#0f7f8c', white: '#9aa0b4',
      brightBlack: '#6b7189', brightRed: '#e5484d', brightGreen: '#1aa772', brightYellow: '#c27c00', brightBlue: '#4a7bf0', brightMagenta: '#a35ef0', brightCyan: '#139aa9', brightWhite: '#c4c8d6',
    },
  };
  window.TermThemes = THEMES;
})();
