//go:build windows

package main

import (
	"context"
	"net"
	"os/exec"
	"strings"
	"syscall"
	"time"

	"github.com/Microsoft/go-winio"
	"github.com/UserExistsError/conpty"
)

type winPTY struct{ c *conpty.ConPty }

func startPTY(shell, cwd string, cols, rows int) (LocalPTY, error) {
	cmdline := shell
	if strings.Contains(shell, " ") && !strings.HasPrefix(shell, `"`) {
		cmdline = `"` + shell + `"`
	}
	c, err := conpty.Start(cmdline, conpty.ConPtyDimensions(cols, rows), conpty.ConPtyWorkDir(cwd))
	if err != nil {
		return nil, err
	}
	return &winPTY{c: c}, nil
}

func (p *winPTY) Read(b []byte) (int, error)  { return p.c.Read(b) }
func (p *winPTY) Write(b []byte) (int, error) { return p.c.Write(b) }
func (p *winPTY) Resize(cols, rows int) error { return p.c.Resize(cols, rows) }
func (p *winPTY) Close() error                { return p.c.Close() }
func (p *winPTY) Wait() (int, error) {
	code, err := p.c.Wait(context.Background())
	return int(code), err
}

// OpenSSH per Windows espone l'agent su una named pipe.
func dialAgent() (net.Conn, error) {
	t := 2 * time.Second
	return winio.DialPipe(`\\.\pipe\openssh-ssh-agent`, &t)
}

// hideWindow evita che si apra una finestra console nera per i processi figli.
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
}
