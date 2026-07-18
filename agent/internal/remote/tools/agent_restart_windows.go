//go:build windows

package tools

import (
	"os/exec"
	"strings"
	"syscall"

	"github.com/breeze-rmm/agent/internal/oscmd"
)

const agentServiceName = "Bl4ckAgent"

func isAgentService(name string) bool {
	return strings.EqualFold(name, agentServiceName)
}

func spawnDelayedRestart() error {
	cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command",
		"Start-Sleep -Seconds 3; Restart-Service -Name Bl4ckAgent")
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP,
	}
	oscmd.Hide(cmd)
	if err := cmd.Start(); err != nil {
		return err
	}
	// Detach so the child survives service stop
	_ = cmd.Process.Release()
	return nil
}

func runAgentRestartNow() error {
	c := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command",
		"Restart-Service -Name Bl4ckAgent")
	oscmd.Hide(c)
	return c.Run()
}
