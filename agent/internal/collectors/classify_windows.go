//go:build windows

package collectors

import (
	"os/exec"
	"strings"

	"github.com/breeze-rmm/agent/internal/oscmd"
)

// getChassisType reads chassis type via WMIC on Windows.
func getChassisType() string {
	c := exec.Command("wmic", "systemenclosure", "get", "ChassisTypes", "/format:list")
	oscmd.Hide(c)
	out, err := c.Output()
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "ChassisTypes=") {
			val := strings.TrimPrefix(line, "ChassisTypes=")
			val = strings.Trim(val, "{}")
			// Take the first value if multiple
			parts := strings.Split(val, ",")
			if len(parts) > 0 {
				return strings.TrimSpace(parts[0])
			}
		}
	}
	return ""
}

// detectLinuxServer is a no-op on Windows.
func detectLinuxServer() bool {
	return false
}
