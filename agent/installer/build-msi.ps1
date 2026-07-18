param(
    [Parameter(Mandatory = $false)]
    [string]$Version = "0.1.0",

    [Parameter(Mandatory = $false)]
    [string]$AgentExePath = "",

    [Parameter(Mandatory = $false)]
    [string]$BackupExePath = "",

    [Parameter(Mandatory = $false)]
    [string]$WatchdogExePath = "",

    [Parameter(Mandatory = $false)]
    [string]$UserHelperExePath = "",

    [Parameter(Mandatory = $false)]
    [string]$OutputPath = ""
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$installerPath = Join-Path $PSScriptRoot "bl4ck.wxs"
$taskXmlPath = Join-Path $repoRoot "service\\windows\\bl4ck-agent-user-task.xml"
$installUserHelperScriptPath = Join-Path $repoRoot "scripts\\install\\install-windows.ps1"
$removeUserHelperScriptPath = Join-Path $PSScriptRoot "remove-windows-task.ps1"

if ([string]::IsNullOrWhiteSpace($AgentExePath)) {
    $AgentExePath = Join-Path $repoRoot "bl4ck-agent-windows-amd64.exe"
}
if ([string]::IsNullOrWhiteSpace($BackupExePath)) {
    $BackupExePath = Join-Path $repoRoot "bl4ck-backup-windows-amd64.exe"
}
if ([string]::IsNullOrWhiteSpace($WatchdogExePath)) {
    $WatchdogExePath = Join-Path $repoRoot "bl4ck-watchdog-windows-amd64.exe"
}
if ([string]::IsNullOrWhiteSpace($UserHelperExePath)) {
    $UserHelperExePath = Join-Path $repoRoot "bl4ck-user-helper-windows-amd64.exe"
}
if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $OutputPath = Join-Path $repoRoot "..\\dist\\bl4ck-agent.msi"
}

if (-not (Get-Command wix -ErrorAction SilentlyContinue)) {
    throw "wix CLI not found. Install WiX v4 first (e.g. 'dotnet tool install --global wix')."
}

# The installer's shell custom actions run via the WiX Util extension's
# WixQuietExec64 / WixSilentExec64 (BinaryRef="Wix4UtilCA_X64") so they launch
# with CREATE_NO_WINDOW (no console flash). Ensure that extension is registered
# globally at the version matching the wix CLI — first-party WiX extensions are
# versioned in lockstep with the toolset. Idempotent: a no-op when already
# present (so it is fast locally where it was added by hand, and self-heals in
# CI where only the CLI is installed).
$wixVersion = ((& wix --version) -replace '\+.*$', '').Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($wixVersion)) {
    throw "Could not determine wix CLI version via 'wix --version'."
}
$utilExtList = (& wix extension list -g 2>$null)
if (-not ($utilExtList -match "WixToolset\.Util\.wixext\s+$([regex]::Escape($wixVersion))")) {
    Write-Host "Registering WixToolset.Util.wixext/$wixVersion ..."
    & wix extension add -g "WixToolset.Util.wixext/$wixVersion"
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to add WixToolset.Util.wixext/$wixVersion. Add it manually: wix extension add -g WixToolset.Util.wixext/$wixVersion"
    }
}

if (-not (Test-Path $installerPath)) {
    throw "Installer definition not found: $installerPath"
}
if (-not (Test-Path $AgentExePath)) {
    throw "Agent executable not found: $AgentExePath"
}
if (-not (Test-Path $BackupExePath)) {
    throw "Backup executable not found: $BackupExePath"
}
if (-not (Test-Path $WatchdogExePath)) {
    throw "Watchdog executable not found: $WatchdogExePath"
}
if (-not (Test-Path $UserHelperExePath)) {
    throw "User-helper executable not found: $UserHelperExePath"
}
if (-not (Test-Path $taskXmlPath)) {
    throw "Task XML not found: $taskXmlPath"
}
if (-not (Test-Path $installUserHelperScriptPath)) {
    throw "User helper install script not found: $installUserHelperScriptPath"
}
if (-not (Test-Path $removeUserHelperScriptPath)) {
    throw "User helper uninstall script not found: $removeUserHelperScriptPath"
}

$msiVersion = ($Version -replace '-.*$', '')
if ($msiVersion -notmatch '^\d+\.\d+\.\d+(\.\d+)?$') {
    throw "Version '$Version' is not MSI-compatible. Use numeric version like 1.2.3 or 1.2.3.4."
}

$outputDir = Split-Path -Parent $OutputPath
if (-not (Test-Path $outputDir)) {
    New-Item -Path $outputDir -ItemType Directory -Force | Out-Null
}

$wixArgs = @(
    "build",
    "$installerPath",
    "-arch", "x64",
    "-ext", "WixToolset.Util.wixext",
    "-d", "Version=$msiVersion",
    "-d", "AgentExePath=$AgentExePath",
    "-d", "BackupExePath=$BackupExePath",
    "-d", "WatchdogExePath=$WatchdogExePath",
    "-d", "UserHelperExePath=$UserHelperExePath",
    "-d", "UserTaskXmlPath=$taskXmlPath",
    "-d", "InstallUserHelperScriptPath=$installUserHelperScriptPath",
    "-d", "RemoveUserHelperScriptPath=$removeUserHelperScriptPath",
    "-o", "$OutputPath"
)

& wix @wixArgs
if ($LASTEXITCODE -ne 0) {
    throw "wix build failed with exit code $LASTEXITCODE"
}

Write-Host "Built MSI at: $OutputPath"
