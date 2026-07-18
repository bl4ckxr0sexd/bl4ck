#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Install BL4CK Agent user helper as a Windows Scheduled Task.
.DESCRIPTION
    Registers the user helper scheduled task so it auto-starts for each user at login.

    Failure diagnostics: when this script fails, the MSI rolls back with
    "installer rolled back" and no actionable text in the default MSI log.
    To preserve the cause, every error path writes a single-line timestamped
    record to C:\ProgramData\BL4CK\logs\user-helper-install-last-error.txt
    (survives the rollback because CA-written files are opaque to MSI) and
    emits an Event Viewer entry under Application/Bl4ckAgent. This mirrors
    the enrollment CA's diagnostic trail.
#>

$ErrorActionPreference = "Stop"

$BinaryPath = "C:\Program Files\BL4CK\bl4ck-agent.exe"
$UserHelperBinaryPath = "C:\Program Files\BL4CK\bl4ck-user-helper.exe"
$TaskXmlPath = Join-Path $PSScriptRoot "..\..\service\windows\bl4ck-agent-user-task.xml"
$TaskName = "\BL4CK\AgentUserHelper"
$LogDir = "C:\ProgramData\BL4CK\logs"
$SentinelPath = Join-Path $LogDir "user-helper-install-last-error.txt"

function Write-FailureDiagnostic {
    param([string]$Message)
    $ts = (Get-Date).ToUniversalTime().ToString("o")
    $line = "$ts $Message"
    # Sentinel file: best-effort. The MSI CA may be running before the logs
    # directory exists, so create it first. Suppress write failures so a
    # broken sentinel never masks the original error.
    try {
        if (-not (Test-Path $LogDir)) {
            New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
        }
        Set-Content -Path $SentinelPath -Value $line -Encoding UTF8 -Force -ErrorAction SilentlyContinue
    } catch {
        # Ignore — sentinel is auxiliary
    }
    # Event Viewer: register the Bl4ckAgent source on first use, then write.
    try {
        if (-not [System.Diagnostics.EventLog]::SourceExists("Bl4ckAgent")) {
            New-EventLog -LogName Application -Source Bl4ckAgent -ErrorAction SilentlyContinue
        }
        Write-EventLog -LogName Application -Source Bl4ckAgent -EntryType Error -EventId 9001 -Message "user-helper task registration: $Message" -ErrorAction SilentlyContinue
    } catch {
        # Ignore — diagnostic is auxiliary
    }
    Write-Error $Message
}

Write-Host "Installing BL4CK Agent User Helper..."

# Verify binaries exist. bl4ck-agent.exe is the console-subsystem CLI binary
# used by the SCM service. bl4ck-user-helper.exe is the GUI-subsystem sibling
# that the scheduled task launches at user logon — same Go source, built with
# -H windowsgui so no console window is allocated in the interactive session.
if (-not (Test-Path $BinaryPath)) {
    Write-FailureDiagnostic "bl4ck-agent.exe not found at $BinaryPath. Install the agent first."
    exit 1
}
if (-not (Test-Path $UserHelperBinaryPath)) {
    Write-FailureDiagnostic "bl4ck-user-helper.exe not found at $UserHelperBinaryPath. Install the agent first."
    exit 1
}

# Find task XML
if (-not (Test-Path $TaskXmlPath)) {
    $TaskXmlPath = Join-Path $PSScriptRoot "..\..\service\windows\bl4ck-agent-user-task.xml"
}
if (-not (Test-Path $TaskXmlPath)) {
    Write-FailureDiagnostic "Task XML template not found at $TaskXmlPath."
    exit 1
}

# Register scheduled task. Register-ScheduledTask -Force is idempotent —
# safe to invoke on first install, major upgrade, and msiexec /fa repair.
try {
    Register-ScheduledTask -Xml (Get-Content $TaskXmlPath -Raw) -TaskName "AgentUserHelper" -TaskPath "\BL4CK\" -Force | Out-Null
    Write-Host "  Scheduled task registered: $TaskName"
    # Clear the sentinel from any prior failed install so support staff can
    # tell a fresh failure from a stale record.
    if (Test-Path $SentinelPath) {
        Remove-Item -Path $SentinelPath -Force -ErrorAction SilentlyContinue
    }
} catch {
    Write-FailureDiagnostic "Failed to register scheduled task: $_"
    exit 1
}

Write-Host ""
Write-Host "BL4CK Agent User Helper installed."
Write-Host "The helper will start automatically at next user login."
Write-Host "To start now: schtasks /run /tn `"$TaskName`""
