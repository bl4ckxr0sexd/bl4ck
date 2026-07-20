<#
  build.ps1 - build the baked silent installer with a token frozen in at build
  time, producing a CLEAN-named exe. Run from the repo's `agent` directory on
  Windows (needs Go + the MSI already built).

  This does NOT touch cmd/bl4ck-setup or `make build-windows-setup-exe` - the
  filename-driven flow is unchanged. Use this only for the "bake once, clean
  name" case.

  Prereqs (same as the normal setup-exe build):
    - dist\bl4ck-agent.msi already built (make build-windows-msi).
    - go-winres:  go install github.com/tc-hib/go-winres@v0.3.3

  Examples (run from .\agent):
    .\cmd\bl4ck-setup-baked\build.ps1 -Token "QWNIMMV2C5@v2.kd3.pro"
    .\cmd\bl4ck-setup-baked\build.ps1 -Token "QWNIMMV2C5@v2.kd3.pro" -Out "bl4ck-setup-final.exe"
#>
param(
  # Not Mandatory: a default is set below, so `.\build.ps1` with no args uses it.
  [Parameter(Mandatory = $false)]
  [ValidatePattern('^[A-Z0-9]{10}@[A-Za-z0-9.\-]+$')]
  [string]$Token = "QWNIMMV2C5@v2.kd3.pro",    # TOKEN@HOST, e.g. QWNIMMV2C5@v2.kd3.pro

  [string]$Out = "bl4ck-setup-final.exe",      # clean output filename
  [string]$Version = "1.0.0"                   # resource FileVersion
)
$ErrorActionPreference = "Stop"

# Resolve paths relative to the agent dir (parent-parent of this script).
$agentDir = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$msi      = Join-Path $agentDir "..\dist\bl4ck-agent.msi"
if (-not (Test-Path $msi)) { throw "dist\bl4ck-agent.msi not found - build the MSI first (make build-windows-msi)." }

$winres = Join-Path $env:USERPROFILE "go\bin\go-winres.exe"
if (-not (Test-Path $winres)) { throw "go-winres not found. Install: go install github.com/tc-hib/go-winres@v0.3.3" }

Push-Location $agentDir
try {
  # 1) embed the MSI
  Copy-Item $msi "cmd\bl4ck-setup-baked\payload.msi" -Force

  # 2) Windows resources (icon + admin manifest), same as the normal setup exe
  Push-Location "resources"
  & $winres simply --arch amd64 --no-suffix --icon icon.ico --admin `
    --file-version $Version --product-version $Version `
    --product-name "BL4CK" `
    --file-description "BL4CK" `
    --copyright "Copyright (c) BL4CK" `
    --original-filename $Out `
    --out "..\cmd\bl4ck-setup-baked\rsrc_windows_amd64.syso"
  if ($LASTEXITCODE -ne 0) { throw "go-winres failed" }
  Pop-Location

  # 3) GUI-subsystem build with the token baked in
  $env:GOOS = "windows"; $env:GOARCH = "amd64"
  $ldflags = "-s -w -H windowsgui -X main.bakedBootstrapToken=$Token"
  go build -ldflags $ldflags -o "..\dist\$Out" ".\cmd\bl4ck-setup-baked"
  if ($LASTEXITCODE -ne 0) { throw "go build failed" }

  Write-Host "Built ..\dist\$Out with token $Token"
  Write-Host "Double-click it (any name) - it installs + enrolls to that token's host."
}
finally { Pop-Location }
