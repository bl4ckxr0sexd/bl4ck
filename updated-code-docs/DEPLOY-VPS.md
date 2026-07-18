# Deploying BL4CK RMM on a Fresh VPS

Goal: a clean VPS running the rebranded BL4CK stack, with a working agent
installer download — **without** depending on GitHub releases, the release
manifest, or code signing.

> **Read this first:** `deploy/docker-compose.prod.yml` pulls digest-pinned
> images from `ghcr.io/lanternops/breeze/*` — the *original* org's registry.
> Using it would run someone else's build, not your rebrand. This guide builds
> from source instead, which is both correct for a rebrand and removes the
> registry dependency.

---

## The key decision: `BINARY_SOURCE`

| Mode | Where installers come from | Needs GitHub release? | Needs signing cert? |
|---|---|---|---|
| `local` ← **use this** | `AGENT_BINARY_DIR` on disk | No | No |
| `github` | your GitHub release + signed manifest | Yes | Yes (Authenticode) |

`fetchRegularMsi()` in `apps/api/src/services/installerBuilder.ts` proves it: in
`local` mode it does a plain `readFile(join(binaryDir,'bl4ck-agent.msi'))` — no
manifest fetch, no signature verification, no network. So a self-hosted VPS works
today. Switch to `github` later, once the cert lands, if you want auto-update
from releases.

---

## 1. VPS prerequisites

```bash
# Ubuntu 22.04/24.04, 4 GB RAM minimum (8 GB recommended), 40 GB disk
sudo apt update && sudo apt install -y docker.io docker-compose-plugin git
sudo usermod -aG docker $USER   # log out/in after this
```

Point your domain's A record at the VPS IP before starting (Caddy needs it for
TLS issuance).

## 2. Clone and prepare

```bash
sudo mkdir -p /opt/bl4ck && sudo chown $USER /opt/bl4ck
git clone https://github.com/bl4ckxr0sexd/bl4ck.git /opt/bl4ck
cd /opt/bl4ck
```

## 3. Generate secrets

Every one of these must be unique and random. Do **not** reuse the placeholder
values from `deploy/.env.example`.

```bash
cd /opt/bl4ck
cat > .env <<EOF
# ---- identity ----
BREEZE_DOMAIN=rmm.yourdomain.com
CORS_ALLOWED_ORIGINS=https://rmm.yourdomain.com
IS_HOSTED=false
ENABLE_REGISTRATION=false
SENTRY_ENVIRONMENT=production
LOG_LEVEL=info

# ---- installers served from disk, not GitHub ----
BINARY_SOURCE=local
AGENT_BINARY_DIR=/app/binaries

# ---- database ----
POSTGRES_USER=bl4ck
POSTGRES_DB=bl4ck
POSTGRES_PASSWORD=$(openssl rand -hex 24)
BREEZE_APP_DB_PASSWORD=$(openssl rand -hex 24)

# ---- redis ----
REDIS_PASSWORD=$(openssl rand -hex 24)
REDIS_MAXMEMORY=256mb

# ---- crypto (LOSING THESE = LOSING YOUR DATA) ----
JWT_SECRET=$(openssl rand -hex 32)
AGENT_ENROLLMENT_SECRET=$(openssl rand -hex 32)
APP_ENCRYPTION_KEY=$(openssl rand -hex 32)
MFA_ENCRYPTION_KEY=$(openssl rand -hex 32)
ENROLLMENT_KEY_PEPPER=$(openssl rand -hex 32)
MFA_RECOVERY_CODE_PEPPER=$(openssl rand -hex 32)
METRICS_SCRAPE_TOKEN=$(openssl rand -hex 16)

# ---- first admin ----
BREEZE_BOOTSTRAP_ADMIN_EMAIL=you@yourdomain.com
BREEZE_BOOTSTRAP_ADMIN_PASSWORD=$(openssl rand -base64 24)
BREEZE_BOOTSTRAP_ADMIN_NAME=Admin

# ---- email (optional but needed for invites/verification) ----
EMAIL_PROVIDER=auto
EMAIL_FROM=noreply@yourdomain.com
RESEND_API_KEY=
EOF
chmod 600 .env
grep BOOTSTRAP_ADMIN_PASSWORD .env   # note this down, then log in and change it
```

**Back up `.env` somewhere safe.** `APP_ENCRYPTION_KEY`, `MFA_ENCRYPTION_KEY`,
and the peppers are unrecoverable — lose them and encrypted columns and enrolled
agents become unreadable.

> `RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS` is **not needed** with
> `BINARY_SOURCE=local`. It is only required when `BINARY_SOURCE=github`, and
> the value in `deploy/.env.example` is the *original* project's key — it will
> not validate your releases. See §7.

## 4. Build and start from source

```bash
cd /opt/bl4ck
docker compose -f docker-compose.yml -f docker-compose.override.yml.local-build up --build -d
docker compose ps
docker compose logs -f api    # watch migrations run on first boot
```

The API runs migrations automatically at startup and provisions the unprivileged
`breeze_app` Postgres role (that role name is intentionally unchanged — it is an
internal identifier, see CHANGELOG "Phase 3").

Verify:

```bash
curl -sf http://localhost:3001/health && echo OK
```

## 5. Stage the agent binaries (this is what makes downloads work)

With `BINARY_SOURCE=local`, the API serves whatever is in `AGENT_BINARY_DIR`.
Build the artifacts on your Windows box (see `BUILD-EXE-INSTALLER.md`) and copy
them up:

```bash
# on your Windows machine
scp dist/bl4ck-agent.msi              user@vps:/tmp/
scp agent/bin/bl4ck-setup.exe         user@vps:/tmp/     # silent EXE installer
scp agent/bl4ck-agent-windows-amd64.exe user@vps:/tmp/
```

```bash
# on the VPS — copy into the binaries volume the api container mounts
docker compose cp /tmp/bl4ck-agent.msi api:/app/binaries/bl4ck-agent.msi
docker compose cp /tmp/bl4ck-agent-windows-amd64.exe api:/app/binaries/
docker compose restart api
```

Filenames must match exactly what the API asks for (`bl4ck-agent.msi`, etc.) —
see the artifact table in `CHANGELOG.md` "Phase 3". A typo produces a 503 on the
download button, not a fallback.

## 6. DNS, TLS, firewall

Caddy terminates TLS and auto-issues Let's Encrypt certs once the A record
resolves.

```bash
sudo ufw allow 22,80,443/tcp && sudo ufw enable
```

Then browse to `https://rmm.yourdomain.com`, log in with the bootstrap admin, and
**change the password immediately**.

## 7. Later: switching to `BINARY_SOURCE=github`

Only worth doing once the signing cert is in place and you're cutting releases
from your own repo.

1. Generate your own manifest signing keypair (never reuse the original
   project's):
   ```bash
   docker run --rm -it alpine sh -c "apk add -q minisign && minisign -G -p /dev/stdout -s /tmp/k"
   openssl genpkey -algorithm ed25519 -out ed25519.pem
   openssl pkey -in ed25519.pem -pubout -outform DER | base64 -w0   # SPKI base64
   ```
2. Add to your GitHub repo secrets: `RELEASE_MANIFEST_MINISIGN_PRIVATE_KEY`,
   `RELEASE_MANIFEST_MINISIGN_PUBLIC_KEY`, `RELEASE_MANIFEST_ED25519_PRIVATE_KEY`,
   `RELEASE_MANIFEST_ED25519_PUBLIC_KEY`.
3. Put the **public** SPKI base64 in the VPS `.env` as
   `RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS=...`
4. Set `BINARY_SOURCE=github`, restart the API.

### Full secret checklist for `release.yml`
| Secret | Needed for | Blocked on |
|---|---|---|
| `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SIGNING_ACCOUNT_NAME`, `AZURE_SIGNING_ENDPOINT`, `AZURE_CERT_PROFILE_PROD`, `AZURE_CERT_PROFILE_PRERELEASE` | Windows Authenticode (MSI + EXE) | your cert |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`, `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_INSTALLER_IDENTITY` | macOS notarization | Apple Developer account |
| `RELEASE_MANIFEST_*` (4) | signed artifact manifest | nothing — generate now |
| `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | viewer/helper auto-update | nothing |
| `BREEZE_API_KEY` | release notifications | nothing |

Without the Apple secrets the macOS jobs fail — if you only ship Windows for
now, disable those jobs rather than letting the whole release fail.

---

## Post-deploy verification

```bash
curl -sf https://rmm.yourdomain.com/health
docker compose ps                       # all services healthy
docker compose logs api | grep -i error
```

In the dashboard:
1. Add Device → Download Installer → confirm you get
   `Bl4ck Agent (TOKEN@rmm.yourdomain.com).msi`
2. Install it on a test machine (from `C:\Users\Public\`, **not** OneDrive)
3. Confirm the device appears online
4. Services show "BL4CK Agent" / "BL4CK RMM Watchdog"

## Troubleshooting

| Symptom | Cause |
|---|---|
| Download button → 503 | `AGENT_BINARY_DIR` missing the exact filename (§5) |
| API won't boot | a required secret is empty, or `IS_HOSTED` unset |
| Install rolls back (1603) | enrollment failed — see `BUILD-EXE-INSTALLER.md` troubleshooting |
| Agent installs but never appears | firewall blocking 443 outbound from the endpoint |
| Cert not issued | A record not resolving yet, or port 80 blocked |
