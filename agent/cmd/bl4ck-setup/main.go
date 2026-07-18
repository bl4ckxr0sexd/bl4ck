// Command bl4ck-setup is a silent, self-contained Windows installer for the
// BL4CK agent. It embeds the product MSI and drives msiexec in fully-quiet mode
// (/qn), so one double-click — or a scripted/GPO/Intune push — installs and
// enrolls with no UI at all.
//
// Why a stub instead of a WiX Burn bundle: the MSI's BootstrapEnroll custom
// action parses the bootstrap token out of [OriginalDatabase] (the MSI's own
// path). A Burn bundle extracts the MSI to a cache path, destroying that name
// and silently breaking enrollment. This stub instead writes the payload out
// under a filename it controls, so the existing MSI and agent enrollment code
// work byte-identically to a directly-downloaded MSI. Nothing in the MSI or the
// agent had to change.
//
// Two enrollment paths, selected automatically:
//
//  1. Per-device token — when this exe is named "BL4CK Agent (TOKEN@HOST).exe",
//     the MSI is written to temp under the SAME base name, so BootstrapEnroll
//     parses (TOKEN@HOST) exactly as before. One download enrolls one machine.
//
//  2. Reusable key — otherwise SERVER_URL / ENROLLMENT_KEY (+ optional
//     ENROLLMENT_SECRET) are handed to msiexec as public properties. The MSI
//     skips BootstrapEnroll when both are set (its condition is
//     `NOT (SERVER_URL AND ENROLLMENT_KEY)`) and runs EnrollAgent instead, so
//     the same exe can be pushed to unlimited endpoints.
//     Values come from /server= /key= /secret= flags, falling back to values
//     baked in at build time via -ldflags -X.
//
// Exit code is msiexec's, so deployment tools see the true result. 3010
// (success, reboot required) is normalised to 0. 1618 (another installation in
// progress) is retried rather than failed — a common cause of spurious
// deployment failures.
package main

import (
	_ "embed"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// payload is the product MSI, embedded at build time. The Makefile copies
// dist/bl4ck-agent.msi here before `go build`; it is gitignored.
//
//go:embed payload.msi
var payload []byte

// Build-time defaults for the reusable-key path (-ldflags "-X main.defaultServer=...").
// Left empty for per-device builds.
var (
	defaultServer = ""
	defaultKey    = ""
	defaultSecret = ""
)

// tokenRe mirrors installerTokenParenRe in internal/agentapp/installer_filename.go.
// Keep the two in sync: this only decides which enrollment path to take, but a
// mismatch would route a tokenised download down the reusable-key path.
var tokenRe = regexp.MustCompile(`\(([A-Z0-9]{10})@([a-zA-Z0-9.\-]+)\)`)

const (
	exitUsage   = 2
	msiRebootOK = 3010 // ERROR_SUCCESS_REBOOT_REQUIRED
	msiBusy     = 1618 // ERROR_INSTALL_ALREADY_RUNNING
	busyRetries = 5
	busyBackoff = 15 * time.Second
)

func main() { os.Exit(run()) }

func run() int {
	logf := newLogger()
	defer logf.Close()

	opts := parseArgs(os.Args[1:])

	exePath, err := os.Executable()
	if err != nil {
		logf.Printf("cannot resolve own path: %v", err)
		return exitUsage
	}
	base := strings.TrimSuffix(filepath.Base(exePath), filepath.Ext(exePath))
	logf.Printf("bl4ck-setup starting; source=%q", filepath.Base(exePath))

	// Decide the enrollment path from our own filename.
	tokenised := tokenRe.MatchString(base)

	// Name the extracted MSI. On the tokenised path the name IS the credential
	// carrier, so it must be preserved verbatim.
	msiName := "bl4ck-agent.msi"
	if tokenised {
		msiName = base + ".msi"
	}

	props, err := enrollProps(tokenised, opts)
	if err != nil {
		logf.Printf("ERROR: %v", err)
		return exitUsage
	}
	if tokenised {
		logf.Printf("enrollment: per-device token from filename")
	} else {
		logf.Printf("enrollment: reusable key; server=%s", props["SERVER_URL"])
	}

	msiPath, cleanup, err := writePayload(msiName)
	if err != nil {
		logf.Printf("ERROR: writing payload: %v", err)
		return exitUsage
	}
	defer cleanup()

	code := runMsiexec(msiPath, props, opts, logf)
	if code == msiRebootOK {
		logf.Printf("install succeeded; reboot required (3010 -> 0)")
		return 0
	}
	if code == 0 {
		logf.Printf("install succeeded")
	} else {
		logf.Printf("install FAILED with exit code %d", code)
	}
	return code
}

// enrollProps builds the msiexec public properties for the reusable-key path.
// The tokenised path deliberately passes none: supplying SERVER_URL+ENROLLMENT_KEY
// would suppress BootstrapEnroll and ignore the filename token.
func enrollProps(tokenised bool, o options) (map[string]string, error) {
	if tokenised {
		return map[string]string{}, nil
	}
	server, key, secret := o.server, o.key, o.secret
	if server == "" {
		server = defaultServer
	}
	if key == "" {
		key = defaultKey
	}
	if secret == "" {
		secret = defaultSecret
	}
	if server == "" || key == "" {
		return nil, fmt.Errorf("no enrollment credentials: name this file " +
			"\"BL4CK Agent (TOKEN@HOST).exe\", or pass /server=<url> /key=<enrollment-key>, " +
			"or build with -ldflags \"-X main.defaultServer=... -X main.defaultKey=...\"")
	}
	p := map[string]string{"SERVER_URL": server, "ENROLLMENT_KEY": key}
	if secret != "" {
		p["ENROLLMENT_SECRET"] = secret
	}
	return p, nil
}

// writePayload materialises the embedded MSI in a private temp directory. A
// dedicated directory (rather than %TEMP% directly) keeps the exact filename
// free of collisions, which matters because the name carries the token.
func writePayload(name string) (string, func(), error) {
	dir, err := os.MkdirTemp("", "bl4ck-setup-")
	if err != nil {
		return "", func() {}, err
	}
	cleanup := func() { os.RemoveAll(dir) }
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, payload, 0o600); err != nil {
		cleanup()
		return "", func() {}, err
	}
	return p, cleanup, nil
}

func runMsiexec(msiPath string, props map[string]string, o options, logf *logger) int {
	args := []string{"/i", msiPath, "/qn", "/norestart"}
	if o.msiLog != "" {
		// Verbose MSI logging is opt-in: it would otherwise record the
		// enrollment key passed as a public property.
		args = append(args, "/l*v", o.msiLog)
	}
	for k, v := range props {
		args = append(args, fmt.Sprintf("%s=%s", k, v))
	}

	for attempt := 1; ; attempt++ {
		cmd := exec.Command("msiexec.exe", args...)
		code := 0
		if err := cmd.Run(); err != nil {
			if ee, ok := err.(*exec.ExitError); ok {
				code = ee.ExitCode()
			} else {
				logf.Printf("msiexec failed to start: %v", err)
				return exitUsage
			}
		}
		if code != msiBusy || attempt > busyRetries {
			return code
		}
		logf.Printf("another installation in progress (1618); retry %d/%d in %s",
			attempt, busyRetries, busyBackoff)
		time.Sleep(busyBackoff)
	}
}

type options struct {
	server, key, secret string
	msiLog              string
}

// parseArgs accepts Windows-style /flag=value and unix-style --flag=value, so
// the same command line works from cmd.exe, PowerShell, and deployment tools.
func parseArgs(argv []string) options {
	var o options
	for _, a := range argv {
		k, v, ok := strings.Cut(strings.TrimLeft(a, "-/"), "=")
		if !ok {
			continue
		}
		switch strings.ToLower(k) {
		case "server":
			o.server = v
		case "key":
			o.key = v
		case "secret":
			o.secret = v
		case "log":
			o.msiLog = v
		}
	}
	return o
}

// logger writes a durable install trail. This binary is built for the GUI
// subsystem (no console) so a file is the only diagnostic channel; a failed
// silent install is otherwise invisible.
type logger struct{ f *os.File }

func newLogger() *logger {
	dir := filepath.Join(os.Getenv("ProgramData"), "BL4CK", "logs")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		dir = os.TempDir()
	}
	f, err := os.OpenFile(filepath.Join(dir, "setup.log"),
		os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return &logger{}
	}
	return &logger{f: f}
}

func (l *logger) Printf(format string, a ...any) {
	if l.f == nil {
		return
	}
	fmt.Fprintf(l.f, "%s %s\n", time.Now().Format(time.RFC3339), fmt.Sprintf(format, a...))
}

func (l *logger) Close() {
	if l.f != nil {
		l.f.Close()
	}
}
