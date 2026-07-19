#!/usr/bin/env bash
# ============================================================================
# BL4CK RMM — stage (unsigned) Windows installers into the binaries volume
# ============================================================================
# In BINARY_SOURCE=local mode the API serves installers from the `bl4ck_binaries`
# Docker volume, read at /data/binaries/agent. That volume is mounted READ-ONLY
# into the api container, so you can't `docker compose cp` into it — this script
# writes to the volume directly via a throwaway container.
#
# Two sources:
#   1) From a GitHub release (recommended — no PC->VPS copying):
#        ./deploy/stage-binaries.sh --release unsigned-latest
#        ./deploy/stage-binaries.sh --release unsigned-latest --repo bl4ckxr0sexd/bl4ck
#      (Build + publish the release with the "Build unsigned installers" GitHub
#       Action, or upload the files to a release manually.)
#   2) From a local directory (files already on the VPS):
#        ./deploy/stage-binaries.sh /path/to/dir
#
# The API re-reads files on every download request, so no restart is needed.
# Re-run any time you publish/rebuild the installers.
# ============================================================================
set -euo pipefail

REPO="${BL4CK_REPO:-bl4ckxr0sexd/bl4ck}"
RELEASE_TAG=""
SRC_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --release) RELEASE_TAG="$2"; shift 2 ;;
    --repo)    REPO="$2"; shift 2 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)         SRC_DIR="$1"; shift ;;
  esac
done

# Files the API expects in /data/binaries/agent (local mode): the MSI + EXE the
# dashboard hands out, plus the raw exes the agent auto-update fetches.
AGENT_FILES=(
  bl4ck-agent.msi
  bl4ck-setup.exe
  bl4ck-agent-windows-amd64.exe
  bl4ck-watchdog-windows-amd64.exe
  bl4ck-user-helper-windows-amd64.exe
)
HELPER_FILES=( bl4ck-helper-windows.msi )   # optional Tauri helper app

cleanup() { [[ -n "${TMP:-}" && -d "${TMP:-}" ]] && rm -rf "$TMP"; }
trap cleanup EXIT

if [[ -n "$RELEASE_TAG" ]]; then
  command -v curl >/dev/null 2>&1 || { echo "ERROR: curl required for --release mode" >&2; exit 1; }
  TMP="$(mktemp -d)"
  SRC_DIR="$TMP"
  base="https://github.com/${REPO}/releases/download/${RELEASE_TAG}"
  echo "==> Downloading installers from ${base} ..."
  for f in "${AGENT_FILES[@]}" "${HELPER_FILES[@]}"; do
    if curl -fsSL "${base}/${f}" -o "${TMP}/${f}"; then
      echo "  downloaded ${f}"
    else
      echo "  (skip ${f} — not in release ${RELEASE_TAG})"
      rm -f "${TMP}/${f}"
    fi
  done
fi

[[ -n "$SRC_DIR" && -d "$SRC_DIR" ]] || {
  echo "Usage: $0 --release <tag> [--repo owner/repo]   |   $0 /path/to/dir" >&2
  exit 1
}
SRC_DIR="$(cd "$SRC_DIR" && pwd)"

# Must match COMPOSE_PROJECT_NAME in install.sh → volume `bl4ck_binaries`.
VOLUME="${BL4CK_BINARIES_VOLUME:-bl4ck_binaries}"
docker volume inspect "$VOLUME" >/dev/null 2>&1 || {
  echo "ERROR: Docker volume '$VOLUME' not found. Bring the stack up first (deploy/install.sh)." >&2
  echo "       If you used a different COMPOSE_PROJECT_NAME, set BL4CK_BINARIES_VOLUME." >&2
  exit 1
}

# Warn about any missing agent file (that download will 404 until present).
missing=0
for f in "${AGENT_FILES[@]}"; do
  [[ -f "$SRC_DIR/$f" ]] || { echo "  WARNING: $f not present (its download will 404)"; missing=$((missing + 1)); }
done
[[ "$missing" -eq 0 ]] || echo "  ($missing expected file(s) missing — staging what's present.)"

echo "==> Staging into volume '$VOLUME' (/data/binaries/agent, .../helper)..."
docker run --rm \
  -v "$VOLUME":/target \
  -v "$SRC_DIR":/src:ro \
  alpine:3.19 sh -c '
    set -e
    mkdir -p /target/agent /target/helper /target/viewer
    for f in bl4ck-agent.msi bl4ck-setup.exe bl4ck-agent-windows-amd64.exe \
             bl4ck-watchdog-windows-amd64.exe bl4ck-user-helper-windows-amd64.exe; do
      [ -f "/src/$f" ] && cp -f "/src/$f" /target/agent/ && echo "  staged agent/$f" || true
    done
    [ -f "/src/bl4ck-helper-windows.msi" ] && cp -f /src/bl4ck-helper-windows.msi /target/helper/ && echo "  staged helper/bl4ck-helper-windows.msi" || true
    [ -s /target/VERSION ] || echo "0.0.0-local" > /target/VERSION
    echo "  contents of /target/agent:"; ls -la /target/agent
  '

echo "==> Done. Dashboard → Add Device → Download Installer now returns"
echo "    Bl4ck Agent (TOKEN@<domain>).msi  (or the .exe via the EXE toggle)."
