# BL4CK Agent — Windows footprint (services, processes, uninstall)

What the BL4CK agent installs and shows on a Windows endpoint. Sourced from the
WiX installer (`agent/installer/bl4ck.wxs`) + the agent service code. All names
are consistently "BL4CK / Bl4ck" — no "Breeze" strings remain in anything a
user sees on Windows.

---

## Task Manager → Services tab (also `services.msc`)

| Service name | Display name | Purpose | Account |
|---|---|---|---|
| `Bl4ckAgent` | **BL4CK Agent** | Main endpoint agent (heartbeats, scripts, patching, remote access, etc.) | LocalSystem |
| `Bl4ckWatchdog` | **BL4CK RMM Watchdog** | Monitors the agent and restarts it if it dies | LocalSystem |

- Description (Bl4ckAgent): "BL4CK RMM endpoint agent"
- Description (Bl4ckWatchdog): "Monitors and recovers the BL4CK RMM Agent"
- Both auto-start and auto-restart on failure (`sc failure … restart/5s/10s/30s`).

## Task Manager → Processes / Details tab (running .exe)

| Process | When it runs | Account |
|---|---|---|
| `bl4ck-agent.exe` | Always (the `Bl4ckAgent` service) | SYSTEM |
| `bl4ck-watchdog.exe` | Always (the `Bl4ckWatchdog` service) | SYSTEM |
| `bl4ck-user-helper.exe` | One per **logged-in user session** — user-context actions, elevation/PAM dialogs, notifications | The logged-in user |
| `bl4ck-backup.exe` | **Transient** — only during backup / bare-metal-recovery jobs, not always resident | SYSTEM |

## Task Scheduler

- `\BL4CK\AgentUserHelper` — launches `bl4ck-user-helper.exe` into the interactive
  user session.

---

## Control Panel → Programs and Features (and Settings → Apps)

- **Name:** **BL4CK Agent**
- **Publisher:** **BL4CK RMM**
- One MSI entry only — the watchdog, user-helper, and backup are all part of it
  (no separate Add/Remove entries).

**What "Uninstall" does:**
1. Kills any running BL4CK processes first (so files aren't locked).
2. Stops **and deletes** both services (`Bl4ckAgent`, `Bl4ckWatchdog`).
3. Removes the install folder and the config files.

---

## Files & registry it installs

**Program folder — `C:\Program Files\BL4CK\`:**
- `bl4ck-agent.exe`
- `bl4ck-watchdog.exe`
- `bl4ck-user-helper.exe`
- `bl4ck-backup.exe`
- `service\` and `scripts\` subfolders

**Data / config / logs — `C:\ProgramData\BL4CK\`:**
- `agent.yaml`, `secrets.yaml` (config — removed on uninstall)
- `data\`, `logs\`

**Registry:**
- `HKLM\SOFTWARE\BL4CK` — config-cleanup marker
- `HKLM\SYSTEM\CurrentControlSet\Control\SafeBoot\Network\Bl4ckAgent` — lets the
  agent run in **Safe Mode with Networking**

---

## Quick reference — every "BL4CK" name a user can see

- **Services:** `Bl4ckAgent`, `Bl4ckWatchdog` (display: "BL4CK Agent", "BL4CK RMM Watchdog")
- **Processes:** `bl4ck-agent.exe`, `bl4ck-watchdog.exe`, `bl4ck-user-helper.exe`, `bl4ck-backup.exe`
- **Installed program:** "BL4CK Agent" by "BL4CK RMM"
- **Scheduled task:** `\BL4CK\AgentUserHelper`
- **Folders:** `C:\Program Files\BL4CK`, `C:\ProgramData\BL4CK`
- **Registry root:** `HKLM\SOFTWARE\BL4CK`

> Note: the silent EXE installer (`bl4ck-setup.exe`) simply wraps and runs this
> same MSI, so the installed footprint is identical.
