// Command bl4ck-setup-baked is a variant of cmd/bl4ck-setup that BAKES the
// per-device bootstrap token (TOKEN@HOST) into the binary at build time, so the
// produced exe can have any clean filename (e.g. bl4ck-setup-final.exe) and still
// enrol exactly like the filename-token flow.
//
// The original cmd/bl4ck-setup is intentionally left UNCHANGED: keep using
// `make build-windows-setup-exe` + renaming the exe to
// "BL4CK Agent (TOKEN@HOST).exe" whenever you want the filename-driven build.
// This command is only for the "bake it once, clean name" case.
//
// How it works: bl4ck-setup writes the embedded MSI to temp and — on the token
// path — names that MSI after the exe's own filename, so the MSI's
// BootstrapEnroll custom action reads (TOKEN@HOST) from the MSI path. Here, when
// the exe filename carries no token, we fall back to the token baked in at build
// time and synthesise the MSI name "BL4CK Agent (TOKEN@HOST).msi" from it — so
// BootstrapEnroll works byte-identically regardless of what the exe is called.
//
// Build (Windows):
//
//	./build.ps1 -Token "QWNIMMV2C5@v2.kd3.pro" -Out bl4ck-setup-final.exe
//
// which passes -ldflags "-X main.bakedBootstrapToken=QWNIMMV2C5@v2.kd3.pro".
//
// Precedence: a real (TOKEN@HOST) in the exe FILENAME still wins (backward
// compatible with the filename flow); otherwise the baked token is used;
// otherwise the reusable /server= /key= path (build-time or runtime) applies.
//
// Exit code is msiexec's (3010 -> 0; 1618 retried), same as bl4ck-setup.
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

// payload is the product MSI, embedded at build time. build.ps1 copies
// dist/bl4ck-agent.msi here before `go build`; it is gitignored.
//
//go:embed payload.msi
var payload []byte

// Build-time bake targets (-ldflags "-X main.<name>=...").
//
//	bakedBootstrapToken — "TOKEN@HOST" for the per-device bootstrap path.
//	defaultServer/Key/Secret — the reusable-key fallback (same as bl4ck-setup).
var (
	bakedBootstrapToken = ""
	defaultServer       = ""
	defaultKey          = ""
	defaultSecret       = ""
)

// tokenRe mirrors installerTokenParenRe in internal/agentapp/installer_filename.go
// and tokenRe in cmd/bl4ck-setup. Matches the (TOKEN@HOST) group.
var tokenRe = regexp.MustCompile(`\(([A-Z0-9]{10})@([a-zA-Z0-9.\-]+)\)`)

// bakedRe validates the baked token, which is stored WITHOUT the surrounding
// parens (e.g. "QWNIMMV2C5@v2.kd3.pro").
var bakedRe = regexp.MustCompile(`^([A-Z0-9]{10})@([a-zA-Z0-9.\-]+)$`)

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
	logf.Printf("bl4ck-setup-baked starting; source=%q", filepath.Base(exePath))

	// Enrollment path selection:
	//  1. A (TOKEN@HOST) in the exe filename wins (matches the filename flow).
	//  2. Else a token baked at build time is used (clean-filename case).
	//  3. Else fall through to the reusable-key path.
	tokenised := false
	msiName := "bl4ck-agent.msi"
	switch {
	case tokenRe.MatchString(base):
		tokenised = true
		msiName = base + ".msi" // filename IS the credential carrier — preserve verbatim
		logf.Printf("enrollment: per-device token from filename")
	case bakedBootstrapToken != "" && bakedRe.MatchString(bakedBootstrapToken):
		tokenised = true
		// Synthesise a tokenised MSI name so BootstrapEnroll reads the baked token.
		msiName = "BL4CK Agent (" + bakedBootstrapToken + ").msi"
		logf.Printf("enrollment: per-device token baked at build time")
	case bakedBootstrapToken != "":
		logf.Printf("ERROR: baked token %q is not in TOKEN@HOST form", bakedBootstrapToken)
		return exitUsage
	}

	props, err := enrollProps(tokenised, opts)
	if err != nil {
		logf.Printf("ERROR: %v", err)
		return exitUsage
	}
	if !tokenised {
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
// The tokenised path (filename OR baked) deliberately passes none.
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
		return nil, fmt.Errorf("no enrollment credentials: build with " +
			"-ldflags \"-X main.bakedBootstrapToken=TOKEN@HOST\", or name this file " +
			"\"BL4CK Agent (TOKEN@HOST).exe\", or pass /server=<url> /key=<enrollment-key>")
	}
	p := map[string]string{"SERVER_URL": server, "ENROLLMENT_KEY": key}
	if secret != "" {
		p["ENROLLMENT_SECRET"] = secret
	}
	return p, nil
}

// writePayload materialises the embedded MSI in a private temp directory so the
// exact filename (which may carry the token) is collision-free.
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

// logger writes a durable install trail (GUI-subsystem binary has no console).
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
