# Deploy BL4CK RMM on a fresh VPS — instructions for Claude Code

**You are Claude Code running on a fresh Linux VPS. Your job: stand up the BL4CK
RMM stack end-to-end and verify it works.** Follow this playbook top to bottom.
Ask the user for the inputs in Step 0, then execute. Do not skip verification.

This is the **pre-signing test deploy**: the app is built from source and serves
**unsigned** Windows installers pulled from a GitHub release (no code-signing
cert required yet). It is production-shaped (real HTTPS, real enrollment), just
with unsigned installers that trigger a Windows SmartScreen/UAC prompt.

---

## Step 0 — Collect these inputs from the user (ASK, don't assume)

| Ask | Example | Notes |
|---|---|---|
| **Domain** for the dashboard | `rmm.example.com` | Must already have a DNS **A record** pointing at THIS VPS's public IP. Required for Let's Encrypt HTTPS + agent TLS. |
| **Admin email** | `you@example.com` | Becomes the first dashboard login + Let's Encrypt account. |
| **Installers release tag** | `unsigned-latest` | The GitHub release holding the unsigned installers (see Step 3). Default `unsigned-latest`. |
| **GitHub repo** | `bl4ckxr0sexd/bl4ck` | Where the code + installers live. Default `bl4ckxr0sexd/bl4ck`. |

Before continuing, confirm with the user:
- The domain's A record already resolves to this VPS (`dig +short <domain>` should
  print this box's public IP). If not, tell them to set it first — Let's Encrypt
  will fail otherwise.
- Ports **80** and **443** are open in the VPS firewall/security group.

---

## Step 1 — Install prerequisites

```bash
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-plugin git openssl curl
sudo systemctl enable --now docker
# allow the current user to run docker without sudo (or just use sudo for docker):
sudo usermod -aG docker "$USER" || true
```
If you added yourself to the `docker` group, either re-login or prefix docker
commands with `sudo` for the rest of this session. Verify:
```bash
sudo docker info >/dev/null && echo "docker OK"
docker compose version
```

## Step 2 — Get the code

```bash
sudo mkdir -p /opt/bl4ck && sudo chown "$USER" /opt/bl4ck
git clone https://github.com/<REPO> /opt/bl4ck
cd /opt/bl4ck
```
Replace `<REPO>` with the repo from Step 0 (default `bl4ckxr0sexd/bl4ck`).
If the deploy scripts live on a feature branch not yet merged to `main`
(ask the user; e.g. `web-exe-installer-option`), clone that branch with
`git clone -b <branch> ...`.

## Step 3 — Make sure the unsigned installers exist on GitHub

The VPS pulls the Windows installers from a GitHub **release**. If the user has
NOT published them yet, tell them to run the GitHub Action once (in the browser):
**repo → Actions → "Build unsigned installers" → Run workflow** (leave the tag as
`unsigned-latest`). It builds the MSI + EXE + agent binaries on a Windows runner
and publishes them to the `unsigned-latest` release. Wait for it to finish
(green check) before continuing.

Sanity check the release has assets:
```bash
curl -fsIL "https://github.com/<REPO>/releases/download/<TAG>/bl4ck-agent.msi" >/dev/null \
  && echo "installers present" || echo "installers NOT found — run the Action first"
```

## Step 4 — Install and bring up the stack (one command)

```bash
cd /opt/bl4ck
./deploy/install.sh \
  --domain <DOMAIN> \
  --admin-email <ADMIN_EMAIL> \
  --binaries-release <TAG> \
  --binaries-repo <REPO>
```
This generates `.env` (all secrets via `openssl`), builds the API/web/portal
images from source (first build ~5–10 min), brings up Postgres/Redis/API/web/
Caddy, waits for the API to report healthy, and auto-stages the installers from
the release. It prints the dashboard URL + admin password (also saved to
`/opt/bl4ck/.admin-password.txt`).

If the user chose **not** to use a release (they have the installer files on the
VPS already), drop `--binaries-release/--binaries-repo` and instead run after
install: `./deploy/stage-binaries.sh /path/to/installer/files`.

## Step 5 — Verify (do all of these; report results to the user)

```bash
cd /opt/bl4ck
export COMPOSE_PROJECT_NAME=bl4ck
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.override.yml.local-build"

# a) all containers healthy
$COMPOSE ps

# b) API health from inside
$COMPOSE exec -T api wget -qO- http://127.0.0.1:3001/health   # expect {"status":"ok",...}

# c) HTTPS + valid cert from outside (give Caddy ~30s after first boot to issue it)
curl -fsS "https://<DOMAIN>/health" && echo "  <- HTTPS + LE cert OK"

# d) installers staged
docker run --rm -v bl4ck_binaries:/b alpine ls -la /b/agent
#   expect bl4ck-agent.msi, bl4ck-setup.exe, and the three -windows-amd64.exe files
```
Then have the user open `https://<DOMAIN>`, log in with the admin email + the
printed password, complete the setup wizard, and go **Add Device → Download
Installer** — it should return `Bl4ck Agent (TOKEN@<DOMAIN>).msi` (or the EXE via
the MSI/EXE toggle). Running it on a Windows machine enrolls the agent (click
through the unsigned SmartScreen/UAC prompt); the device appears online within a
minute.

## Step 6 — Report to the user

Summarize: dashboard URL, admin login, that HTTPS/cert is valid, that installers
are staged, and the one caveat — **installers are unsigned** so Windows shows a
SmartScreen/UAC warning (expected until code signing is set up). Signing later is
just: set the Azure signing secrets + `ENABLE_WINDOWS_SIGNING=true`, cut a signed
release, and flip `.env` to `BINARY_SOURCE=github` — no redeploy of data.

---

## Troubleshooting (consult only if a step fails)

- **`.env` errors / API won't boot:** `"$COMPOSE" logs api | tail -n 120`. The
  validator names the missing/invalid var. Common: a secret too short, or two
  secrets equal. Fix in `/opt/bl4ck/.env` and `"$COMPOSE" up -d api`.
- **Caddy cert fails:** DNS A record must resolve to this box and ports 80/443
  open BEFORE first HTTPS hit. Check `"$COMPOSE" logs caddy`. Fix DNS/firewall,
  then `"$COMPOSE" restart caddy`.
- **Download Installer 404s:** the installer file isn't in the volume. Re-run
  `./deploy/stage-binaries.sh --release <TAG> --repo <REPO>` and confirm Step 5d.
- **Postgres/redis won't start:** usually a blank `POSTGRES_PASSWORD`/
  `REDIS_PASSWORD` in `.env` — regenerate `.env` (delete it and re-run install.sh).
- **amd64 build:** `.env` sets `DOCKER_PLATFORM=linux/amd64` — leave it; the repo
  default is arm64 (for Apple Silicon dev).
- **Rebuild after a git pull:** `"$COMPOSE" up --build -d`.
- **Full reset (wipes data):** `"$COMPOSE" down -v` then re-run install.sh.

Do NOT print secret values from `.env` back to the user beyond the one-time admin
password. Keep `/opt/bl4ck/.env` mode 600.
