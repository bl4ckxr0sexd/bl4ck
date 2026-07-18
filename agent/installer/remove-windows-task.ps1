#Requires -RunAsAdministrator
$ErrorActionPreference = "Stop"

$taskName = "AgentUserHelper"
$taskPath = "\\BL4CK\\"

try {
    $existing = Get-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction SilentlyContinue
    if ($existing) {
        Unregister-ScheduledTask -TaskName $taskName -TaskPath $taskPath -Confirm:$false
    }
} catch {
    # Ignore task cleanup errors during uninstall to avoid blocking removal.
}
