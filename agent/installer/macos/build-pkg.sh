#!/bin/bash
# ============================================
# BL4CK Agent macOS .pkg Builder
# ============================================
# Usage:
#   ./build-pkg.sh <agent-binary> <desktop-helper-binary> <backup-binary> <watchdog-binary> <version> <arch> <output-path>
#
# Example:
#   ./build-pkg.sh ./bl4ck-agent-darwin-amd64 ./bl4ck-desktop-helper-darwin-amd64 ./bl4ck-backup-darwin-amd64 ./bl4ck-watchdog-darwin-amd64 0.13.3 amd64 ./dist/bl4ck-agent-darwin-amd64.pkg
# ============================================

set -euo pipefail

AGENT_BIN="$1"
DESKTOP_HELPER_BIN="$2"
BACKUP_BIN="$3"
WATCHDOG_BIN="$4"
VERSION="$5"
ARCH="$6"
OUTPUT="$7"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

echo "Building BL4CK Agent .pkg"
echo "  Agent:    $AGENT_BIN"
echo "  Desktop:  $DESKTOP_HELPER_BIN"
echo "  Backup:   $BACKUP_BIN"
echo "  Watchdog: $WATCHDOG_BIN"
echo "  Version:  $VERSION"
echo "  Arch:     $ARCH"
echo "  Output:   $OUTPUT"
echo ""

# ----- Build payload root -----
# Mirror the on-disk layout the installer will create
PAYLOAD="$WORK_DIR/payload"
mkdir -p "$PAYLOAD/usr/local/bin"
mkdir -p "$PAYLOAD/Library/LaunchDaemons"
mkdir -p "$PAYLOAD/Library/LaunchAgents"

cp "$AGENT_BIN" "$PAYLOAD/usr/local/bin/bl4ck-agent"
chmod 755 "$PAYLOAD/usr/local/bin/bl4ck-agent"

cp "$DESKTOP_HELPER_BIN" "$PAYLOAD/usr/local/bin/bl4ck-desktop-helper"
chmod 755 "$PAYLOAD/usr/local/bin/bl4ck-desktop-helper"

# Install backup binary
cp "$BACKUP_BIN" "$PAYLOAD/usr/local/bin/bl4ck-backup"
chmod 755 "$PAYLOAD/usr/local/bin/bl4ck-backup"

# Install watchdog binary
cp "$WATCHDOG_BIN" "$PAYLOAD/usr/local/bin/bl4ck-watchdog"
chmod 755 "$PAYLOAD/usr/local/bin/bl4ck-watchdog"

cp "$SCRIPT_DIR/../../service/launchd/com.bl4ck.agent.plist" \
   "$PAYLOAD/Library/LaunchDaemons/com.bl4ck.agent.plist"

cp "$SCRIPT_DIR/../../service/launchd/com.bl4ck.desktop-helper-user.plist" \
   "$PAYLOAD/Library/LaunchAgents/com.bl4ck.desktop-helper-user.plist"

cp "$SCRIPT_DIR/../../service/launchd/com.bl4ck.desktop-helper-loginwindow.plist" \
   "$PAYLOAD/Library/LaunchAgents/com.bl4ck.desktop-helper-loginwindow.plist"

# Install watchdog launchd plist
cp "$SCRIPT_DIR/com.bl4ck.watchdog.plist" \
   "$PAYLOAD/Library/LaunchDaemons/com.bl4ck.watchdog.plist"

# ----- Prepare install scripts -----
SCRIPTS="$WORK_DIR/scripts"
mkdir -p "$SCRIPTS"
cp "$SCRIPT_DIR/preinstall" "$SCRIPTS/preinstall"
cp "$SCRIPT_DIR/postinstall" "$SCRIPTS/postinstall"
chmod 755 "$SCRIPTS/preinstall" "$SCRIPTS/postinstall"

# ----- Build component package -----
mkdir -p "$(dirname "$OUTPUT")"

pkgbuild \
    --root "$PAYLOAD" \
    --scripts "$SCRIPTS" \
    --identifier "com.bl4ck.agent" \
    --version "$VERSION" \
    --install-location "/" \
    "$OUTPUT"

echo ""
echo "Package built: $OUTPUT"
ls -lh "$OUTPUT"
