//go:build windows

// Package oscmd centralizes the "don't flash a console window" behavior that
// every console-subsystem child process (powershell.exe, wmic.exe, cmd.exe,
// sc.exe, ...) needs when spawned by the agent.
//
// The agent's inventory collectors, security probes and user-session helper all
// shell out to these tools. Without CREATE_NO_WINDOW the kernel allocates a
// fresh console for each child, which flashes a black window on the interactive
// desktop — most visibly right after install, when the service runs its first
// full inventory sweep and fires dozens of these in a row. Routing every spawn
// through oscmd.Hide fixes that in one place instead of relying on each call
// site to remember the flag.
package oscmd

import (
	"os/exec"
	"syscall"

	"golang.org/x/sys/windows"
)

// Hide suppresses the console window of a console-subsystem child process.
// It augments any SysProcAttr already set on cmd (e.g. CREATE_NEW_PROCESS_GROUP)
// rather than replacing it, so it is safe to call after other process
// attributes have been configured. Calling it on a nil cmd is a no-op.
func Hide(cmd *exec.Cmd) {
	if cmd == nil {
		return
	}
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.HideWindow = true
	cmd.SysProcAttr.CreationFlags |= windows.CREATE_NO_WINDOW
}
