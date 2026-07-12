#!/usr/bin/env bash
#
# setup.sh — one-command installer for this Breeze RMM fork.
#
# Handles the FULL install on a fresh Docker host:
#   1. Preflight (docker, docker compose v2, openssl)
#   2. CPU-arch detection -> correct build platform (amd64 / arm64)
#   3. .env creation from .env.example + generation of every required secret
#   4. Reusable + long-lived installer defaults (this fork's whole point)
#   5. docker-compose.override.yml generation (builds images from source and
#      maps the enrollment-key env vars the base compose file does NOT map)
#   6. Build + bring the stack up + wait for health
#
# Re-running is safe: existing (non-placeholder) secrets are preserved, so an
# `up`grade never rotates your keys or invalidates sessions/enrollment hashes.
#
# Usage:
#   ./setup.sh                          # interactive prompts (recommended)
#   ./setup.sh --domain rmm.example.com --acme-email you@example.com \
#              --admin-email you@example.com --admin-password 'ChangeMe123#abc' \
#              --non-interactive
#   ./setup.sh --no-build               # write config only, don't build/start
#
# Env-var equivalents: BREEZE_DOMAIN, ACME_EMAIL, ADMIN_EMAIL, ADMIN_PASSWORD.
#
set -euo pipefail

# --------------------------------------------------------------------------
# pretty logging
# --------------------------------------------------------------------------
if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_BLUE=$'\033[1;34m'; C_GREEN=$'\033[1;32m'
  C_YELLOW=$'\033[1;33m'; C_RED=$'\033[1;31m'; C_DIM=$'\033[2m'
else
  C_RESET=""; C_BLUE=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_DIM=""
fi
info()  { printf '%s==>%s %s\n' "$C_BLUE"  "$C_RESET" "$*"; }
ok()    { printf '%s ok%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn()  { printf '%s  !%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
die()   { printf '%serror%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# --------------------------------------------------------------------------
# args / defaults
# --------------------------------------------------------------------------
BREEZE_VERSION_PIN="0.94.0"
DOMAIN="${BREEZE_DOMAIN:-}"
ACME="${ACME_EMAIL:-}"
ADMIN_EMAIL="${ADMIN_EMAIL:-}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
NON_INTERACTIVE=0
DO_BUILD=1

while [ $# -gt 0 ]; do
  case "$1" in
    --domain)          DOMAIN="$2"; shift 2 ;;
    --acme-email)      ACME="$2"; shift 2 ;;
    --admin-email)     ADMIN_EMAIL="$2"; shift 2 ;;
    --admin-password)  ADMIN_PASSWORD="$2"; shift 2 ;;
    --non-interactive) NON_INTERACTIVE=1; shift ;;
    --no-build)        DO_BUILD=0; shift ;;
    -h|--help)
      sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
done

# --------------------------------------------------------------------------
# 1. preflight
# --------------------------------------------------------------------------
info "Checking prerequisites"
command -v docker  >/dev/null 2>&1 || die "docker is not installed. See https://docs.docker.com/engine/install/"
command -v openssl >/dev/null 2>&1 || die "openssl is not installed (needed to generate secrets)."
if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  die "docker compose v2 not found. Install the Docker Compose plugin."
fi
docker info >/dev/null 2>&1 || die "cannot talk to the Docker daemon (is it running? do you need sudo?)."
ok "docker + compose + openssl present"

# --------------------------------------------------------------------------
# 2. arch detection
# --------------------------------------------------------------------------
case "$(uname -m)" in
  x86_64|amd64)        PLATFORM="linux/amd64" ;;
  aarch64|arm64)       PLATFORM="linux/arm64" ;;
  *) warn "unrecognised CPU arch '$(uname -m)', defaulting to linux/amd64"; PLATFORM="linux/amd64" ;;
esac
ok "build platform: $PLATFORM"

# --------------------------------------------------------------------------
# .env helpers (in-place, order-preserving; ENVIRON avoids escape mangling)
# --------------------------------------------------------------------------
get_env() { grep -E "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2- || true; }

set_env() { # set_env KEY VALUE  — replace in place, or append if absent
  local key="$1"
  export _SE_KEY="$key" _SE_VAL="$2"
  if grep -qE "^${key}=" .env; then
    awk 'BEGIN{k=ENVIRON["_SE_KEY"];v=ENVIRON["_SE_VAL"]}
         { if (index($0,k"=")==1) print k"="v; else print }' .env > .env.tmp && mv .env.tmp .env
  else
    printf '%s=%s\n' "$key" "$_SE_VAL" >> .env
  fi
  unset _SE_KEY _SE_VAL
}

is_placeholder() { # true when a value is empty or an .env.example placeholder
  case "$1" in
    ""|*change*|*change-me*|*CHANGE*|generate-a-random*|your-*|another-secret*|__GENERATE_ME__|breeze_secure_password_change_me|changeme) return 0 ;;
    *) return 1 ;;
  esac
}

# generate a secret only if the current value is still a placeholder
gen_if_placeholder() { # gen_if_placeholder KEY  <generator-command...>
  local key="$1"; shift
  if is_placeholder "$(get_env "$key")"; then
    set_env "$key" "$("$@")"
    printf '   generated %s\n' "$key"
  else
    printf '   kept existing %s\n' "$key"
  fi
}
rand_b64() { openssl rand -base64 "${1:-32}" | tr -d '\n'; }
rand_hex() { openssl rand -hex "${1:-32}" | tr -d '\n'; }

# --------------------------------------------------------------------------
# 3. .env + secrets
# --------------------------------------------------------------------------
if [ ! -f .env ]; then
  [ -f .env.example ] || die ".env.example not found — are you in the repo root?"
  cp .env.example .env
  ok "created .env from .env.example"
else
  info ".env already exists — preserving existing secrets, updating config"
fi

info "Generating required secrets (idempotent)"
gen_if_placeholder POSTGRES_PASSWORD      rand_hex 24
gen_if_placeholder REDIS_PASSWORD         rand_hex 32
gen_if_placeholder JWT_SECRET             rand_b64 64
gen_if_placeholder AGENT_ENROLLMENT_SECRET rand_hex 32
gen_if_placeholder APP_ENCRYPTION_KEY     rand_hex 32
gen_if_placeholder MFA_ENCRYPTION_KEY     rand_hex 32
gen_if_placeholder ENROLLMENT_KEY_PEPPER  rand_b64 32
gen_if_placeholder MFA_RECOVERY_CODE_PEPPER rand_b64 32
gen_if_placeholder SESSION_SECRET         rand_b64 48
gen_if_placeholder METRICS_SCRAPE_TOKEN   rand_hex 32
gen_if_placeholder TURN_SECRET            rand_hex 32
ok "secrets ready"

# --------------------------------------------------------------------------
# 4. deployment config + reusable/long-lived installer knobs
# --------------------------------------------------------------------------
# collect domain / email / admin (prompt unless supplied or --non-interactive)
prompt() { # prompt VAR "Question" "default"
  local __var="$1" q="$2" def="$3" ans
  if [ "$NON_INTERACTIVE" = "1" ] || [ ! -t 0 ]; then
    printf -v "$__var" '%s' "$def"; return
  fi
  read -r -p "$q [${def}]: " ans || true
  printf -v "$__var" '%s' "${ans:-$def}"
}

[ -n "$DOMAIN" ]      || prompt DOMAIN      "Public domain (DNS must point here for TLS)" "localhost"
[ -n "$ACME" ]        || prompt ACME        "Email for Let's Encrypt / ACME"             "admin@${DOMAIN}"
[ -n "$ADMIN_EMAIL" ] || prompt ADMIN_EMAIL "Bootstrap admin login email"                "admin@${DOMAIN}"
if [ -z "$ADMIN_PASSWORD" ]; then
  if [ "$NON_INTERACTIVE" = "1" ] || [ ! -t 0 ]; then
    ADMIN_PASSWORD="$(rand_b64 18)"          # 24 chars, printed at the end
    GENERATED_ADMIN_PW=1
  else
    prompt ADMIN_PASSWORD "Bootstrap admin password (min 16 chars)" "$(rand_b64 18)"
  fi
fi
# production requires >= 16 chars — pad a too-short one deterministically
if [ "${#ADMIN_PASSWORD}" -lt 16 ]; then
  warn "admin password < 16 chars; appending random suffix to satisfy the production policy"
  ADMIN_PASSWORD="${ADMIN_PASSWORD}$(rand_hex 8)"
fi

info "Writing deployment config"
set_env BREEZE_DOMAIN                "$DOMAIN"
set_env ACME_EMAIL                   "$ACME"
set_env BREEZE_VERSION               "$BREEZE_VERSION_PIN"
set_env NODE_ENV                     "production"
set_env BINARY_SOURCE                "github"
set_env BREEZE_BOOTSTRAP_ADMIN_EMAIL "$ADMIN_EMAIL"
set_env BREEZE_BOOTSTRAP_ADMIN_PASSWORD "$ADMIN_PASSWORD"

# --- the reason this fork exists: reusable + 1-year installers -------------
# unlimited => child enrollment keys minted per install carry no usage cap
set_env CHILD_ENROLLMENT_KEY_MAX_USAGE     "unlimited"
# 525600 minutes = 365 days, applied to child keys, parent-key default, and
# the bootstrap token embedded in each downloaded installer
set_env CHILD_ENROLLMENT_KEY_TTL_MINUTES   "525600"
set_env ENROLLMENT_KEY_DEFAULT_TTL_MINUTES "525600"
set_env INSTALLER_BOOTSTRAP_TOKEN_TTL_MINUTES "525600"
ok "config written (domain=$DOMAIN, version=$BREEZE_VERSION_PIN, installers=reusable/1-year)"

# --------------------------------------------------------------------------
# 5. docker-compose.override.yml (gitignored — generated per host)
# --------------------------------------------------------------------------
# Builds the api/web/portal images from THIS source tree and, crucially, maps
# the four enrollment-key env vars into the api service. The base
# docker-compose.yml does not map them, so without this override the API falls
# back to code defaults (1-hour parent key, 24-hour token) and installers are
# neither reusable nor long-lived.
info "Generating docker-compose.override.yml"
cat > docker-compose.override.yml <<YAML
# GENERATED BY setup.sh — do not edit by hand; re-run setup.sh to regenerate.
# Builds images from source for this host's architecture ($PLATFORM) and maps
# the reusable/long-lived installer env vars that the base compose omits.
services:
  binaries-init:
    image: alpine:3.19
    entrypoint: ["sh", "-c", "mkdir -p /target/agent /target/viewer /target/helper && echo '0.0.0-dev' > /target/VERSION && echo 'Stub binaries volume created'"]

  api:
    image: breeze-api:local
    platform: $PLATFORM
    build:
      context: .
      dockerfile: docker/Dockerfile.api
    environment:
      BINARY_SOURCE: \${BINARY_SOURCE:-github}
      CHILD_ENROLLMENT_KEY_MAX_USAGE: \${CHILD_ENROLLMENT_KEY_MAX_USAGE:-unlimited}
      CHILD_ENROLLMENT_KEY_TTL_MINUTES: \${CHILD_ENROLLMENT_KEY_TTL_MINUTES:-1440}
      ENROLLMENT_KEY_DEFAULT_TTL_MINUTES: \${ENROLLMENT_KEY_DEFAULT_TTL_MINUTES:-60}
      INSTALLER_BOOTSTRAP_TOKEN_TTL_MINUTES: \${INSTALLER_BOOTSTRAP_TOKEN_TTL_MINUTES:-1440}
      ENROLLMENT_KEY_PEPPER: \${ENROLLMENT_KEY_PEPPER:?Set ENROLLMENT_KEY_PEPPER in .env}
      MFA_RECOVERY_CODE_PEPPER: \${MFA_RECOVERY_CODE_PEPPER:?Set MFA_RECOVERY_CODE_PEPPER in .env}
      ANTHROPIC_API_KEY: \${ANTHROPIC_API_KEY:-}
      TRUST_PROXY_HEADERS: \${TRUST_PROXY_HEADERS:-true}
      AUTH_COOKIE_SAME_SITE: \${AUTH_COOKIE_SAME_SITE:-Lax}
      PORTAL_COOKIE_SAME_SITE: \${PORTAL_COOKIE_SAME_SITE:-Lax}
      TURN_HOST: \${TURN_HOST:-}
      TURN_PORT: \${TURN_PORT:-3478}
      TURN_SECRET: \${TURN_SECRET:-}

  web:
    image: breeze-web:local
    platform: $PLATFORM
    build:
      context: .
      dockerfile: docker/Dockerfile.web
      args:
        PUBLIC_API_URL: ""
        PUBLIC_APP_VERSION: \${BREEZE_VERSION:-dev}
    healthcheck:
      test: ['CMD', 'wget', '--no-verbose', '--tries=1', '--spider', 'http://127.0.0.1:4321/']
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 30s

  portal:
    image: breeze-portal:local
    platform: $PLATFORM
    build:
      context: .
      dockerfile: apps/portal/Dockerfile
      args:
        PORTAL_BASE_PATH: \${PORTAL_BASE_PATH:-/portal}
        PUBLIC_API_URL: ""
    healthcheck:
      test: ['CMD-SHELL', 'wget --no-verbose --tries=1 --spider "http://127.0.0.1:4322\${PORTAL_BASE_PATH:-/portal}/login"']
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 30s
YAML
ok "docker-compose.override.yml generated"

# --------------------------------------------------------------------------
# 6. build + up + wait for health
# --------------------------------------------------------------------------
if [ "$DO_BUILD" = "0" ]; then
  warn "--no-build: config written but stack NOT started. Run: $DC up -d --build"
  exit 0
fi

info "Building images from source (first run downloads base layers — can take a while)"
$DC build

info "Starting the stack"
$DC up -d

info "Waiting for the API to become healthy"
deadline=$(( $(date +%s) + 300 ))
while :; do
  status="$($DC ps --format '{{.Service}} {{.Status}}' 2>/dev/null | grep -E '^api ' || true)"
  case "$status" in
    *healthy*) ok "api is healthy"; break ;;
  esac
  if [ "$(date +%s)" -ge "$deadline" ]; then
    warn "api did not report healthy within 300s — showing recent logs:"
    $DC logs --tail 40 api || true
    break
  fi
  sleep 5
done

# --------------------------------------------------------------------------
# done — summary
# --------------------------------------------------------------------------
echo
printf '%s========================================================%s\n' "$C_GREEN" "$C_RESET"
printf '%s Breeze is up.%s\n' "$C_GREEN" "$C_RESET"
printf '%s========================================================%s\n' "$C_GREEN" "$C_RESET"
if [ "$DOMAIN" = "localhost" ]; then
  echo "  URL:            https://localhost  (self-signed cert — accept the warning)"
else
  echo "  URL:            https://$DOMAIN"
  echo "                  (DNS A/AAAA for $DOMAIN must point at this host, ports 80+443 open, for the TLS cert)"
fi
echo "  Admin login:    $ADMIN_EMAIL"
if [ "${GENERATED_ADMIN_PW:-0}" = "1" ]; then
  printf '  Admin password: %s%s%s  (generated — save it now)\n' "$C_YELLOW" "$ADMIN_PASSWORD" "$C_RESET"
else
  echo "  Admin password: (the one you set)"
fi
echo
echo "  Installers are REUSABLE (unlimited devices) and valid ~365 days."
echo
printf '%s  Security: after your first successful login, remove these two lines\n' "$C_YELLOW"
printf '  from .env and run \"%s up -d\" so the bootstrap credential is not\n' "$DC"
printf '  left on disk:%s\n' "$C_RESET"
echo "     BREEZE_BOOTSTRAP_ADMIN_EMAIL"
echo "     BREEZE_BOOTSTRAP_ADMIN_PASSWORD"
echo
echo "  Manage:  $DC ps   |   $DC logs -f api   |   $DC down"
