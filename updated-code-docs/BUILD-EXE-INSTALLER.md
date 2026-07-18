# Building the BL4CK Silent EXE Installer

`bl4ck-setup.exe` is a single-file, fully silent Windows installer. It embeds the
product MSI and drives `msiexec /qn`, so one double-click (or a GPO/Intune/RMM
push) installs the agent and enrolls it with **no UI at all**.

The MSI is still the primary artifact — the EXE wraps it. Both ship.

---

## Why a Go stub and not a WiX Burn bundle

The MSI's `BootstrapEnroll` custom action reads the bootstrap token out of
`[OriginalDatabase]` — the MSI's **own filename**, e.g.
`BL4CK Agent (GHU24L3IKN@v1.kd3.pro).msi`.

A WiX Burn bundle extracts the MSI to a cache path with a different name, which
destroys that filename and **silently breaks enrollment**. The Go stub instead
writes the payload out under a filename it controls, so the existing MSI and
agent enrollment code behave byte-identically to a directly-downloaded MSI.

**Nothing in the MSI or the agent had to change to support the EXE.**

---

## Prerequisites

| Tool | Install |
|---|---|
| Go (1.22+) | https://go.dev/dl/ |
| WiX v5 CLI | `dotnet tool install --global wix` |
| go-winres | `go install github.com/tc-hib/go-winres@v0.3.3` |
| PowerShell | ships with Windows |

Make sure `$(go env GOPATH)/bin` is on your `PATH` so `go-winres` resolves.

---

## Build steps

### 1. Generate Windows resources (icon, version info, BL4CK file properties)

Run from `agent/`. This bakes "BL4CK RMM Agent" etc. into each binary's
Properties → Details tab, and applies the correct UAC manifest per binary.

```bash
cd agent
make build-winres VERSION=1.0.0
```

**No `make`?** (Git Bash on Windows usually has none.) Run the equivalent
directly — this is the exact sequence the target runs:

```bash
cd agent/resources
V=1.0.0
go-winres simply --arch amd64 --no-suffix --icon icon.ico --admin \
  --file-version $V --product-version $V --product-name "BL4CK RMM Agent" \
  --file-description "BL4CK RMM Agent" --copyright "Copyright (c) BL4CK RMM" \
  --original-filename "bl4ck-agent.exe" --out ../cmd/bl4ck-agent/rsrc_windows_amd64.syso
go-winres simply --arch amd64 --no-suffix --icon icon.ico \
  --file-version $V --product-version $V --product-name "BL4CK RMM User Helper" \
  --file-description "BL4CK RMM User Helper" --copyright "Copyright (c) BL4CK RMM" \
  --original-filename "bl4ck-user-helper.exe" --out ../cmd/bl4ck-user-helper/rsrc_windows_amd64.syso
go-winres simply --arch amd64 --no-suffix --icon icon.ico \
  --file-version $V --product-version $V --product-name "BL4CK RMM Watchdog" \
  --file-description "BL4CK RMM Watchdog" --copyright "Copyright (c) BL4CK RMM" \
  --original-filename "bl4ck-watchdog.exe" --out ../cmd/bl4ck-watchdog/rsrc_windows_amd64.syso
go-winres simply --arch amd64 --no-suffix --icon icon.ico \
  --file-version $V --product-version $V --product-name "BL4CK RMM Backup Helper" \
  --file-description "BL4CK RMM Backup Helper" --copyright "Copyright (c) BL4CK RMM" \
  --original-filename "bl4ck-backup.exe" --out ../cmd/bl4ck-backup/rsrc_windows_amd64.syso
cd ..
```

> Skipping this step still produces working binaries — they just show no
> product/description metadata in Explorer.

### 2. Build the four Windows binaries the MSI packages

Output names must match what `installer/build-msi.ps1` expects (agent root).

```bash
cd agent
VERSION=1.0.0
GOOS=windows GOARCH=amd64 go build -ldflags "-s -w -X main.version=$VERSION" -o bl4ck-agent-windows-amd64.exe    ./cmd/bl4ck-agent
GOOS=windows GOARCH=amd64 go build -ldflags "-s -w -X main.version=$VERSION" -o bl4ck-backup-windows-amd64.exe   ./cmd/bl4ck-backup
GOOS=windows GOARCH=amd64 go build -ldflags "-s -w -X main.version=$VERSION" -o bl4ck-watchdog-windows-amd64.exe ./cmd/bl4ck-watchdog
GOOS=windows GOARCH=amd64 go build -ldflags "-s -w -X main.version=$VERSION -H windowsgui" -o bl4ck-user-helper-windows-amd64.exe ./cmd/bl4ck-user-helper
```

`-s -w` strips symbols/DWARF (~25-30% smaller; panic traces still work).
`-H windowsgui` on the user-helper prevents a console window in the user session.

### 3. Build the MSI

```powershell
pwsh -File agent/installer/build-msi.ps1 -Version 1.0.0
# -> dist/bl4ck-agent.msi   (~25.6 MB)
```

The script self-heals its WiX dependency: it checks `wix extension list -g` and
installs `WixToolset.Util.wixext` at the matching CLI version if missing.

### 4. Build the silent EXE

```bash
cd agent
make build-windows-setup-exe VERSION=1.0.0
# -> agent/bin/bl4ck-setup.exe   (~29 MB = 26 MB embedded MSI + stub)
```

This copies `dist/bl4ck-agent.msi` → `cmd/bl4ck-setup/payload.msi` (gitignored),
generates the setup exe's resources, and compiles GUI-subsystem so there is no
console flash.

**No `make`?** Run the same three steps directly (this is the exact sequence
used to produce the shipped `bl4ck-setup.exe`):

```bash
cd agent
V=1.0.0
# a) embed the MSI as the payload
cp ../dist/bl4ck-agent.msi cmd/bl4ck-setup/payload.msi
# b) resources: icon + BL4CK properties + requireAdministrator (self-elevates)
cd resources && go-winres simply --arch amd64 --no-suffix --icon icon.ico --admin \
  --file-version $V --product-version $V --product-name "BL4CK RMM Agent Setup" \
  --file-description "BL4CK RMM Agent Setup" --copyright "Copyright (c) BL4CK RMM" \
  --original-filename "bl4ck-setup.exe" --out ../cmd/bl4ck-setup/rsrc_windows_amd64.syso && cd ..
# c) build (GUI subsystem = no console window)
GOOS=windows GOARCH=amd64 go build -ldflags "-s -w -H windowsgui" \
  -o bl4ck-setup.exe ./cmd/bl4ck-setup
```

To bake in reusable credentials without `make`, add to the `-ldflags` string:
`-X main.defaultServer=https://v1.kd3.pro -X main.defaultKey=<key>`

**Optional — bake in reusable enrollment credentials** for mass deployment, so
the exe needs no arguments and no special filename:

```bash
make build-windows-setup-exe VERSION=1.0.0 \
  SETUP_SERVER=https://v1.kd3.pro \
  SETUP_KEY=<enrollment-key> \
  SETUP_SECRET=<optional-secret>
```

---

## The two enrollment modes

The stub picks its path automatically from its own filename.

| How you ship it | What happens |
|---|---|
| Renamed to `BL4CK Agent (TOKEN@HOST).exe` | Extracts the MSI under that **same** name → `BootstrapEnroll` parses `(TOKEN@HOST)`. One download = one machine (token is single-use). |
| `bl4ck-setup.exe /server=https://v1.kd3.pro /key=<key>` | Passes `SERVER_URL` + `ENROLLMENT_KEY` as MSI properties → MSI skips `BootstrapEnroll` and runs `EnrollAgent`. Reusable on unlimited machines. |
| `bl4ck-setup.exe` built with `SETUP_SERVER`/`SETUP_KEY` | Same as above, zero arguments. Best for GPO / Intune / scripted push. |

Flags accept both `/flag=value` and `--flag=value` (cmd.exe, PowerShell, and
deployment tools all work). Supported: `/server=`, `/key=`, `/secret=`, `/log=`.

### Behaviour that matters for unattended deployment
- Runs `msiexec /qn /norestart` — no UI, no reboot.
- Returns **msiexec's real exit code** so deployment tools see the truth.
- `3010` (success, reboot required) is normalised to `0`.
- `1618` (another install in progress) is **retried 5× at 15s** instead of failing —
  a common cause of spurious deployment failures.
- Always logs to `C:\ProgramData\BL4CK\logs\setup.log`. The exe is GUI-subsystem
  (no console), so this file is the only diagnostic channel.
- Verbose MSI logging is **opt-in** via `/log=<path>` — it is off by default
  because it would record the enrollment key passed as a public property.

---

## Testing

Install from a path **SYSTEM can read** — not OneDrive, and ideally not a mapped
drive. `C:\Users\Public\` is the safe default.

```powershell
Copy-Item agent\bin\bl4ck-setup.exe "C:\Users\Public\BL4CK Agent (NEWTOKEN@v1.kd3.pro).exe"
# double-click it, or:
Start-Process "C:\Users\Public\BL4CK Agent (NEWTOKEN@v1.kd3.pro).exe" -Verb RunAs -Wait
```

Then confirm:

```powershell
Get-Service | Where-Object Name -match 'Bl4ck'          # Bl4ckAgent, Bl4ckWatchdog = Running
Get-ChildItem "C:\Program Files\BL4CK"                   # 4 binaries present
Get-Process | Where-Object ProcessName -match 'bl4ck'    # bl4ck-agent.exe running
Get-Content C:\ProgramData\BL4CK\logs\setup.log -Tail 20 # install trail
```

And the device should appear in the dashboard.

---

## Troubleshooting

### Install fails with 1603 and everything disappears
`BootstrapEnroll` / `EnrollAgent` are `Return="check"`, so a failed enrollment
rolls back the **entire** install — no services, no files, no Add/Remove entry.
An empty Control Panel therefore means *enrollment* failed, not that the
installer is broken.

Read the real cause from the Windows event log (no elevation needed):

```powershell
Get-WinEvent -FilterHashtable @{LogName='Application'; StartTime=(Get-Date).AddHours(-1)} |
  Where-Object ProviderName -match 'MsiInstaller' |
  Select-Object TimeCreated, Id, Message | Format-List
```

For the failing action, capture a verbose MSI log with `/log=`, then decode it —
**MSI logs are UTF-16**, so plain grep finds nothing:

```bash
tr -d '\000' < install.log > /tmp/msi.log
grep -n "Return value 3" /tmp/msi.log       # the failing action
grep -nE "Action (start|ended)" /tmp/msi.log
```

### Enrollment fails with `400 {"error":"missing token"}`
A wire-protocol header was renamed. **Headers sent to the server must keep their
original `X-Breeze-*` spelling** — the server is not rebranded. See the
"Phase 2 FIX" section of `CHANGELOG.md`. Currently:
`X-Breeze-Bootstrap-Token`, `X-Breeze-Role`. Do not rename these.

### Install rolls back only when run from certain folders
The deferred custom actions run as `SYSTEM`. SYSTEM cannot read a user's OneDrive
profile folder. Always test from `C:\Users\Public\`.

### `pattern payload.msi: no matching files found`
The MSI wasn't copied into `cmd/bl4ck-setup/` before `go build`. Run step 3, then
step 4 (the Make target does the copy for you).

---

## Before shipping: code signing

This is the single biggest real-world reliability factor, and it is **not**
solved by installer design.

An unsigned ~29 MB self-extracting executable is close to a worst case for
SmartScreen and AV heuristics — it will get "Unknown Publisher" warnings and is a
prime candidate for quarantine. A quarantined installer is exactly the failure
mode that breaks a "never disconnects" deployment.

Sign **both** `bl4ck-setup.exe` and `bl4ck-agent.msi`, plus the four agent
binaries, with an OV or (better, for instant SmartScreen reputation) EV code
signing certificate, or Azure Trusted Signing. Sign the binaries *before*
building the MSI, and the MSI *before* embedding it in the EXE — otherwise the
outer signature covers unsigned inner payloads.
