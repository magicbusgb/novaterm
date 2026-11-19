package main

import (
	"context"
	"embed"
	"io/fs"
	"log"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/linux"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

//go:embed all:frontend
var embedded embed.FS

//go:embed build/appicon.png
var appIcon []byte

const appVersion = "2.0.0"

func frontendFS() fs.FS {
	sub, err := fs.Sub(embedded, "frontend")
	if err != nil {
		log.Fatal(err)
	}
	return sub
}

func main() {
	if runDevWeb() { // solo con il build tag "devweb" (test)
		return
	}
	app := NewApp()
	dark := app.store.Settings().Theme != "light"
	bg := &options.RGBA{R: 11, G: 13, B: 20, A: 255}
	theme := windows.Dark
	if !dark {
		bg = &options.RGBA{R: 246, G: 247, B: 251, A: 255}
		theme = windows.Light
	}
	err := wails.Run(&options.App{
		Title:            "NovaTerm",
		Width:            1480,
		Height:           920,
		MinWidth:         900,
		MinHeight:        560,
		BackgroundColour: bg,
		AssetServer:      &assetserver.Options{Assets: frontendFS()},
		OnStartup: func(ctx context.Context) {
			app.attach(&wailsTransport{ctx: ctx}, &wailsDialogs{ctx: ctx})
			runtime.OnFileDrop(ctx, func(x, y int, paths []string) {
				app.emit("file:drop", map[string]any{"x": x, "y": y, "paths": paths})
			})
		},
		OnShutdown: func(ctx context.Context) { app.shutdown() },
		Bind:       []interface{}{app},
		DragAndDrop: &options.DragAndDrop{
			EnableFileDrop:     true,
			DisableWebViewDrop: true,
		},
		Windows: &windows.Options{Theme: theme},
		Mac: &mac.Options{
			TitleBar: mac.TitleBarDefault(),
			About:    &mac.AboutInfo{Title: "NovaTerm", Message: "Client SSH moderno con Claude Code integrato", Icon: appIcon},
		},
		Linux: &linux.Options{Icon: appIcon, ProgramName: "NovaTerm"},
	})
	if err != nil {
		log.Fatal(err)
	}
}

// ------------------------------------------------------------------ trasporto Wails

type wailsTransport struct{ ctx context.Context }

func (w *wailsTransport) Emit(name string, args ...any) { runtime.EventsEmit(w.ctx, name, args...) }
func (w *wailsTransport) OpenURL(url string)            { runtime.BrowserOpenURL(w.ctx, url) }
func (w *wailsTransport) ClipboardGet() (string, error) { return runtime.ClipboardGetText(w.ctx) }
func (w *wailsTransport) ClipboardSet(t string) error   { return runtime.ClipboardSetText(w.ctx, t) }

type wailsDialogs struct{ ctx context.Context }

func filters(f []FileFilter) []runtime.FileFilter {
	out := make([]runtime.FileFilter, 0, len(f))
	for _, x := range f {
		out = append(out, runtime.FileFilter{DisplayName: x.Name, Pattern: x.Pattern})
	}
	return out
}

func (d *wailsDialogs) OpenFile(title string, f []FileFilter) (string, error) {
	return runtime.OpenFileDialog(d.ctx, runtime.OpenDialogOptions{Title: title, Filters: filters(f), ShowHiddenFiles: true})
}
func (d *wailsDialogs) OpenFiles(title string) ([]string, error) {
	return runtime.OpenMultipleFilesDialog(d.ctx, runtime.OpenDialogOptions{Title: title, ShowHiddenFiles: true})
}
func (d *wailsDialogs) OpenDir(title string) (string, error) {
	return runtime.OpenDirectoryDialog(d.ctx, runtime.OpenDialogOptions{Title: title, CanCreateDirectories: true})
}
func (d *wailsDialogs) SaveFile(title, dir, name string, f []FileFilter) (string, error) {
	return runtime.SaveFileDialog(d.ctx, runtime.SaveDialogOptions{Title: title, DefaultDirectory: dir, DefaultFilename: name, Filters: filters(f), CanCreateDirectories: true})
}
