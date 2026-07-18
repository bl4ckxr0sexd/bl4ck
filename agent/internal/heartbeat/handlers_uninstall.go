package heartbeat

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/oscmd"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func init() {
	handlerRegistry[tools.CmdSelfUninstall] = handleSelfUninstall
}

// handleSelfUninstall performs a best-effort service uninstall and cleanup.
// The handler sends back a success result before triggering the actual
// uninstall so the API receives acknowledgement. The process will exit
// as part of the service teardown.
func handleSelfUninstall(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()

	removeConfig := tools.GetPayloadBool(cmd.Payload, "removeConfig", true)

	log.Warn("self_uninstall command received — uninstalling agent",
		"removeConfig", removeConfig,
	)

	// Schedule the actual uninstall to happen after we return the result.
	// This gives processCommand time to submit the result back to the API.
	go func() {
		defer func() {
			if r := recover(); r != nil {
				log.Error("panic during self-uninstall", "panic", fmt.Sprint(r))
			}
		}()

		// Brief delay so the command result can be submitted
		time.Sleep(2 * time.Second)

		if err := performSelfUninstall(removeConfig); err != nil {
			log.Error("self-uninstall partially failed", "error", err.Error())
			// Even if uninstall fails, shut down the agent
		}

		// Signal the agent to stop. This triggers the graceful shutdown path.
		h.StopAcceptingCommands()
		h.Stop()

		// If we're still alive after Stop (e.g., not running as a service),
		// force exit.
		time.Sleep(5 * time.Second)
		os.Exit(0)
	}()

	return tools.NewSuccessResult(map[string]string{
		"message": "self-uninstall scheduled",
	}, time.Since(start).Milliseconds())
}

// performSelfUninstall does the platform-specific service removal.
func performSelfUninstall(removeConfig bool) error {
	switch runtime.GOOS {
	case "darwin":
		return selfUninstallDarwin(removeConfig)
	case "linux":
		return selfUninstallLinux(removeConfig)
	case "windows":
		return selfUninstallWindows(removeConfig)
	default:
		return fmt.Errorf("unsupported OS for self-uninstall: %s", runtime.GOOS)
	}
}

// selfUninstallDarwin removes the launchd service, plists, and binary on macOS.
func selfUninstallDarwin(removeConfig bool) error {
	const (
		label            = "com.bl4ck.agent"
		userLabel        = "com.bl4ck.agent-user"
		watchdogLabel    = "com.bl4ck.watchdog"
		plistDst         = "/Library/LaunchDaemons/com.bl4ck.agent.plist"
		userPlistDst     = "/Library/LaunchAgents/com.bl4ck.agent-user.plist"
		watchdogPlistDst = "/Library/LaunchDaemons/com.bl4ck.watchdog.plist"
		binaryPath       = "/usr/local/bin/bl4ck-agent"
		watchdogBinary   = "/usr/local/bin/bl4ck-watchdog"
		configDir        = "/Library/Application Support/BL4CK"
	)

	var errs []string

	// Bootout the daemon (this will kill us, but we try anyway)
	bootoutDaemon := exec.Command("launchctl", "bootout", "system/"+label)
	oscmd.Hide(bootoutDaemon)
	if err := bootoutDaemon.Run(); err != nil {
		log.Warn("launchctl bootout failed, trying legacy unload", "error", err.Error())
		unloadDaemon := exec.Command("launchctl", "unload", plistDst)
		oscmd.Hide(unloadDaemon)
		if err2 := unloadDaemon.Run(); err2 != nil {
			errs = append(errs, fmt.Sprintf("daemon unload: %s", err2.Error()))
		}
	}

	// Remove user helper
	bootoutUser := exec.Command("launchctl", "bootout", "system/"+userLabel)
	oscmd.Hide(bootoutUser)
	if err := bootoutUser.Run(); err != nil {
		unloadUser := exec.Command("launchctl", "unload", userPlistDst)
		oscmd.Hide(unloadUser)
		_ = unloadUser.Run()
	}
	bootoutWatchdog := exec.Command("launchctl", "bootout", "system/"+watchdogLabel)
	oscmd.Hide(bootoutWatchdog)
	if err := bootoutWatchdog.Run(); err != nil {
		unloadWatchdog := exec.Command("launchctl", "unload", watchdogPlistDst)
		oscmd.Hide(unloadWatchdog)
		_ = unloadWatchdog.Run()
	}

	// Remove plists
	if err := os.Remove(plistDst); err != nil && !os.IsNotExist(err) {
		errs = append(errs, fmt.Sprintf("remove %s: %s", plistDst, err.Error()))
	}
	if err := os.Remove(userPlistDst); err != nil && !os.IsNotExist(err) {
		log.Warn("failed to remove user plist", "error", err.Error())
	}
	if err := os.Remove(watchdogPlistDst); err != nil && !os.IsNotExist(err) {
		errs = append(errs, fmt.Sprintf("remove %s: %s", watchdogPlistDst, err.Error()))
	}

	// Remove binary
	if err := os.Remove(binaryPath); err != nil && !os.IsNotExist(err) {
		errs = append(errs, fmt.Sprintf("remove binary: %s", err.Error()))
	}
	if err := os.Remove(watchdogBinary); err != nil && !os.IsNotExist(err) {
		errs = append(errs, fmt.Sprintf("remove watchdog binary: %s", err.Error()))
	}

	// Optionally remove config
	if removeConfig {
		if err := os.RemoveAll(configDir); err != nil {
			errs = append(errs, fmt.Sprintf("remove config: %s", err.Error()))
		}
	}

	if len(errs) > 0 {
		return fmt.Errorf("partial failure: %s", strings.Join(errs, "; "))
	}
	return nil
}

// selfUninstallLinux removes the systemd service, unit files, and binary on Linux.
func selfUninstallLinux(removeConfig bool) error {
	const (
		serviceName     = "bl4ck-agent"
		watchdogService = "bl4ck-watchdog"
		unitDst         = "/etc/systemd/system/bl4ck-agent.service"
		watchdogUnitDst = "/etc/systemd/system/bl4ck-watchdog.service"
		userUnitDst     = "/usr/lib/systemd/user/bl4ck-agent-user.service"
		binaryPath      = "/usr/local/bin/bl4ck-agent"
		watchdogBinary  = "/usr/local/bin/bl4ck-watchdog"
		configDir       = "/etc/bl4ck"
	)

	var errs []string

	// Stop and disable the service
	stopSvc := exec.Command("systemctl", "stop", serviceName)
	oscmd.Hide(stopSvc)
	if err := stopSvc.Run(); err != nil {
		log.Warn("systemctl stop failed", "error", err.Error())
		errs = append(errs, fmt.Sprintf("stop service: %s", err.Error()))
	}
	disableSvc := exec.Command("systemctl", "disable", serviceName)
	oscmd.Hide(disableSvc)
	if err := disableSvc.Run(); err != nil {
		log.Warn("systemctl disable failed", "error", err.Error())
	}
	stopWatchdog := exec.Command("systemctl", "stop", watchdogService)
	oscmd.Hide(stopWatchdog)
	if err := stopWatchdog.Run(); err != nil {
		log.Warn("systemctl stop watchdog failed", "error", err.Error())
	}
	disableWatchdog := exec.Command("systemctl", "disable", watchdogService)
	oscmd.Hide(disableWatchdog)
	if err := disableWatchdog.Run(); err != nil {
		log.Warn("systemctl disable watchdog failed", "error", err.Error())
	}

	// Remove unit files
	if err := os.Remove(unitDst); err != nil && !os.IsNotExist(err) {
		errs = append(errs, fmt.Sprintf("remove %s: %s", unitDst, err.Error()))
	}
	if err := os.Remove(watchdogUnitDst); err != nil && !os.IsNotExist(err) {
		errs = append(errs, fmt.Sprintf("remove %s: %s", watchdogUnitDst, err.Error()))
	}
	if err := os.Remove(userUnitDst); err != nil && !os.IsNotExist(err) {
		log.Warn("failed to remove user unit", "error", err.Error())
	}

	// Reload systemd
	daemonReload := exec.Command("systemctl", "daemon-reload")
	oscmd.Hide(daemonReload)
	_ = daemonReload.Run()

	// Remove binary
	if err := os.Remove(binaryPath); err != nil && !os.IsNotExist(err) {
		errs = append(errs, fmt.Sprintf("remove binary: %s", err.Error()))
	}
	if err := os.Remove(watchdogBinary); err != nil && !os.IsNotExist(err) {
		errs = append(errs, fmt.Sprintf("remove watchdog binary: %s", err.Error()))
	}

	// Optionally remove config
	if removeConfig {
		if err := os.RemoveAll(configDir); err != nil {
			errs = append(errs, fmt.Sprintf("remove config: %s", err.Error()))
		}
	}

	if len(errs) > 0 {
		return fmt.Errorf("partial failure: %s", strings.Join(errs, "; "))
	}
	return nil
}

// selfUninstallWindows removes the Windows service and binary.
// Note: Uses sc.exe rather than the SCM API (golang.org/x/sys/windows/svc/mgr)
// to avoid the complexity of deleting a service from within its own process context.
func selfUninstallWindows(removeConfig bool) error {
	const (
		serviceName         = "Bl4ckAgent"
		watchdogServiceName = "Bl4ckWatchdog"
	)

	var errs []string

	// Stop the service via sc.exe
	stopSvc := exec.Command("sc.exe", "stop", serviceName)
	oscmd.Hide(stopSvc)
	if err := stopSvc.Run(); err != nil {
		log.Warn("sc.exe stop failed", "error", err.Error())
		errs = append(errs, fmt.Sprintf("stop service: %s", err.Error()))
	}
	time.Sleep(2 * time.Second)

	// Delete the service registration
	deleteSvc := exec.Command("sc.exe", "delete", serviceName)
	oscmd.Hide(deleteSvc)
	if err := deleteSvc.Run(); err != nil {
		log.Warn("sc.exe delete failed", "error", err.Error())
		errs = append(errs, fmt.Sprintf("delete service: %s", err.Error()))
	}
	stopWatchdog := exec.Command("sc.exe", "stop", watchdogServiceName)
	oscmd.Hide(stopWatchdog)
	if err := stopWatchdog.Run(); err != nil {
		log.Warn("sc.exe stop watchdog failed", "error", err.Error())
	}
	deleteWatchdog := exec.Command("sc.exe", "delete", watchdogServiceName)
	oscmd.Hide(deleteWatchdog)
	if err := deleteWatchdog.Run(); err != nil {
		log.Warn("sc.exe delete watchdog failed", "error", err.Error())
	}

	// Remove binary — get our own path first
	exePath, err := os.Executable()
	if err == nil {
		// Schedule deletion after process exits (Windows locks running executables).
		// Pass the entire command as a single string so cmd.exe interprets the
		// shell operators (>, &) correctly.
		delCmd := fmt.Sprintf(`ping 127.0.0.1 -n 3 >NUL & del /f "%s"`, exePath)
		cleanupCmd := exec.Command("cmd", "/C", delCmd)
		oscmd.Hide(cleanupCmd)
		if err := cleanupCmd.Start(); err != nil {
			log.Warn("failed to schedule binary cleanup", "path", exePath, "error", err.Error())
		}
	}

	// Optionally remove config
	if removeConfig {
		configDir := os.Getenv("ProgramData")
		if configDir != "" {
			if err := os.RemoveAll(configDir + "\\BL4CK"); err != nil {
				errs = append(errs, fmt.Sprintf("remove config: %s", err.Error()))
			}
		}
	}

	if len(errs) > 0 {
		return fmt.Errorf("partial failure: %s", strings.Join(errs, "; "))
	}
	return nil
}
