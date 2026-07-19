# Wipe the existing panel and reinstall the updated BL4CK — for Claude Code on the VPS

**You are Claude Code on a VPS that already runs an older BL4CK / Breeze panel.
Your job: COMPLETELY remove the existing deployment (containers, volumes, and ALL
data — this is irreversible), then do a clean install of the updated private
repo.** This is a DESTRUCTIVE reset. Confirm data loss with the user before you
delete anything.

## Step 0 — Collect + confirm
Ask the user for:
- **Domain** (e.g. `rmm.example.com`) and **admin email**.
- **Fine-grained GitHub token** with `Contents: Read` on `bl4ckxr0sexd/bl4ck`
  (private repo — needed to clone + pull the installer release). Never print it.
- **Explicit confirmation** that wiping the old panel's database/volumes is OK —
  say clearly: *"This deletes the existing panel and all its data permanently."*
  Do not proceed without a yes.

```bash
export GITHUB_TOKEN='<fine-grained token>'
```

## Step 1 — Find the existing install
```bash
# Where the old stack lives + what's running:
ls -la /opt/bl4ck /opt/breeze 2>/dev/null
docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Status}}'
docker volume ls
```
The old compose project is usually under `/opt/bl4ck` or `/opt/breeze`. Identify
its directory (call it `$OLD`) and note any `docker-compose*.yml` there.

## Step 2 — Tear it down completely (DESTRUCTIVE)
Prefer a clean compose teardown from the old dir; then hard-remove leftovers.
```bash
OLD=/opt/bl4ck            # <-- set to the real old dir you found

# a) Clean compose teardown (removes its containers + named volumes + networks).
if [ -d "$OLD" ]; then
  cd "$OLD"
  # Use whatever compose files exist there; -v drops the DB/redis/binaries volumes.
  docker compose down -v --remove-orphans 2>/dev/null || \
  docker compose -f docker-compose.yml -f docker-compose.override.yml.local-build down -v --remove-orphans 2>/dev/null || true
fi

# b) Belt-and-suspenders: remove any stray bl4ck/breeze containers + volumes by name.
docker ps -aq --filter 'name=bl4ck' --filter 'name=breeze' | xargs -r docker rm -f
docker volume ls -q | grep -Ei 'bl4ck|breeze' | xargs -r docker volume rm

# c) Remove the old code + its .env (contains old secrets).
sudo rm -rf "$OLD"

# d) (optional) reclaim space from old images/build cache.
docker image prune -af
docker builder prune -af
```
After this, `docker ps -a` and `docker volume ls` should show NO bl4ck/breeze
containers or volumes. Verify before continuing.

## Step 3 — Fresh clone of the updated repo (private → token in URL)
```bash
sudo mkdir -p /opt/bl4ck && sudo chown "$USER" /opt/bl4ck
git clone "https://x-access-token:${GITHUB_TOKEN}@github.com/bl4ckxr0sexd/bl4ck" /opt/bl4ck
cd /opt/bl4ck
```

## Step 4 — Install (generates fresh secrets, builds, pulls installers)
Make sure prereqs exist (a box that ran the old panel already has docker):
```bash
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-plugin git openssl curl python3
```
Then:
```bash
cd /opt/bl4ck
./deploy/install.sh \
  --domain <DOMAIN> \
  --admin-email <ADMIN_EMAIL> \
  --binaries-release downloads
```
`GITHUB_TOKEN` (still exported) lets install.sh pull the private `downloads`
release. It builds from source, brings up the stack with Caddy auto-HTTPS, runs
migrations on the FRESH (empty) database, seeds the admin, and stages the
installers. It prints the dashboard URL + a NEW admin password.

## Step 5 — Verify (report to the user)
```bash
cd /opt/bl4ck
export COMPOSE_PROJECT_NAME=bl4ck
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.override.yml.local-build"
$COMPOSE ps                                                   # all healthy
$COMPOSE exec -T api wget -qO- http://127.0.0.1:3001/health   # {"status":"ok"}
curl -fsS "https://<DOMAIN>/health" && echo "  HTTPS OK"       # valid LE cert
docker run --rm -v bl4ck_binaries:/b alpine ls -la /b/agent   # installers staged
```
Then have the user log in at `https://<DOMAIN>` with the new admin password,
complete the setup wizard, and test Add Device → Download Installer.

## Notes
- This is a full reset: the new panel starts with a BRAND-NEW database and new
  secrets — nothing from the old panel (devices, users, history) carries over.
  If the user wanted to KEEP old data, STOP — this is the wrong playbook.
- Keep `/opt/bl4ck/.env` mode 600; don't print secrets beyond the one-time admin
  password. Troubleshooting: see `deploy/DEPLOY-WITH-CLAUDE.md` (same stack).
