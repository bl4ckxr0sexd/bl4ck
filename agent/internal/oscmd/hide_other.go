//go:build !windows

package oscmd

import "os/exec"

// Hide is a no-op on non-Windows platforms, which have no detachable console
// window to suppress. It mirrors the Windows signature so call sites stay
// platform-agnostic.
func Hide(cmd *exec.Cmd) {}
