package agentapp

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/breeze-rmm/agent/internal/oscmd"
)

// isPermissionError checks whether an error chain contains a permission-denied error.
func isPermissionError(err error) bool {
	if errors.Is(err, os.ErrPermission) {
		return true
	}
	// Also check for EACCES directly (covers wrapped syscall errors)
	var pathErr *os.PathError
	if errors.As(err, &pathErr) {
		return errors.Is(pathErr.Err, syscall.EACCES)
	}
	return false
}

// isSystemServiceRunning checks if the BL4CK Agent is running as a system service.
func isSystemServiceRunning() bool {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	switch runtime.GOOS {
	case "darwin":
		c := exec.CommandContext(ctx, "launchctl", "print", "system/com.bl4ck.agent")
		oscmd.Hide(c)
		return c.Run() == nil
	case "linux":
		c := exec.CommandContext(ctx, "systemctl", "is-active", "bl4ck-agent")
		oscmd.Hide(c)
		out, err := c.Output()
		return err == nil && strings.TrimSpace(string(out)) == "active"
	case "windows":
		c := exec.CommandContext(ctx, "sc", "query", "Bl4ckAgent")
		oscmd.Hide(c)
		out, err := c.Output()
		return err == nil && strings.Contains(string(out), "RUNNING")
	default:
		return false
	}
}
