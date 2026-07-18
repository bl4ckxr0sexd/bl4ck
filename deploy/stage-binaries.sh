#!/usr/bin/env bash
# ============================================================================
# BL4CK RMM — stage (unsigned) Windows installers into the binaries volume
# ============================================================================
# In BINARY_SOURCE=local mode the API serves installers from the `bl4ck_binaries`
# Docker volume, which it reads at /data/binaries/agent. That volume is mounted
# READ-ONLY into the api container, so you can't `docker compose cp` into it —
# this script writes to the volume directly via a throwaway container.
#
# Build the installers on a WINDOWS machine (see updated-code-docs/
# BUILD-EXE-INSTALLER.md), copy them to this VPS, then:
#   ./deploy/stage-binaries.sh /path/to/dir
#
# The API re-reads the files on every download request, so no restart is needed.
# Re-run any time you rebuild the installers.
# ============================================================================
set -euo pipefail

SRC="${1:-}"
[[ -n "$SRC" && -d "$SRC" ]] || { echo "Usage: $0 /path/to/dir/with/bl4ck-installers" >&2; exit 1; }
SRC="$(cd "$SRC" && pwd)"

# Must match COMPOSE_PROJECT_NAME in install.sh → volume name `bl4ck_binaries`.
VOLUME="${BL4CK_BINARIES_VOLUME:-bl4ck_binaries}"
docker volume inspect "$VOLUME" >/dev/null 2>&1 || {
  echo "ERROR: Docker volume '$VOLUME' not found. Bring the stack up first (deploy/install.sh)." >&2
  echo "       If you used a different COMPOSE_PROJECT_NAME, set BL4CK_BINARIES_VOLUME." >&2
  exit 1
}

# What the API looks for in /data/binaries/agent (local mode). The .exe/.msi the
# dashboard hands out; the raw agent/watchdog/user-helper exes for auto-update.
EXPECTED=(
  bl4ck-agent.msi
  bl4ck-setup.exe
  bl4ck-agent-windows-amd64.exe
  bl4ck-watchdog-windows-amd64.exe
  bl4ck-user-helper-windows-amd64.exe
)

missing=0
for f in "${EXPECTED[@]}"; do
  if [[ ! -f "$SRC/$f" ]]; then
    echo "  WARNING: $f not found in $SRC (that download will 404 until you add it)"
    missing=$((missing + 1))
  fi
done
[[ "$missing" -eq 0 ]] || echo "  ($missing expected file(s) missing — staging what's present.)"

echo "==> Copying installers from $SRC into volume '$VOLUME' (/data/binaries/agent)..."
# agent/* holds the agent + msi + setup exe; helper/* holds the Tauri helper msi
# if you ship it. Copy everything the source dir has; create the layout + VERSION.
docker run --rm \
  -v "$VOLUME":/target \
  -v "$SRC":/src:ro \
  alpine:3.19 sh -c '
    set -e
    mkdir -p /target/agent /target/helper /target/viewer
    # agent-scoped installers/binaries
    for f in bl4ck-agent.msi bl4ck-setup.exe bl4ck-agent-windows-amd64.exe \
             bl4ck-watchdog-windows-amd64.exe bl4ck-user-helper-windows-amd64.exe; do
      [ -f "/src/$f" ] && cp -f "/src/$f" /target/agent/ && echo "  staged agent/$f" || true
    done
    # optional Tauri helper app installer
    [ -f "/src/bl4ck-helper-windows.msi" ] && cp -f /src/bl4ck-helper-windows.msi /target/helper/ && echo "  staged helper/bl4ck-helper-windows.msi" || true
    # a VERSION marker (any non-empty value is fine for local mode)
    [ -s /target/VERSION ] || echo "0.0.0-local" > /target/VERSION
    echo "  contents of /target/agent:"; ls -la /target/agent
  '

echo "==> Done. Test: dashboard → Add Device → Download Installer should now return"
echo "    Bl4ck Agent (TOKEN@<domain>).msi  (or the .exe via the EXE toggle)."
