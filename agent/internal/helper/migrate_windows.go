package helper

import (
	"github.com/breeze-rmm/agent/internal/sessionbroker"
	"golang.org/x/sys/windows/registry"
)

func migrateLegacyPlatform() {
	stopHelperLegacy()

	// Remove old registry autostart key ("BL4CKHelper", not "BL4CKAssist")
	key, err := registry.OpenKey(registry.LOCAL_MACHINE, registryKey, registry.SET_VALUE)
	if err != nil {
		return
	}
	defer key.Close()
	_ = key.DeleteValue("BL4CKHelper")
}

func stopHelperLegacy() {
	_ = runHelperCommand("taskkill", "/F", "/IM", "BL4CK Helper.exe")
	_ = runHelperCommand("taskkill", "/F", "/IM", "bl4ck-helper.exe")
}

func migrationTargets() ([]string, error) {
	sessionID := sessionbroker.GetConsoleSessionID()
	if sessionID == "" || sessionID == "0" {
		return nil, nil
	}
	return []string{sessionID}, nil
}

func prepareSessionDir(path, sessionKey string) error {
	return nil
}
