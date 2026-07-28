# BL4CK RMM — Install or Update (instructions for Claude Code)

**You are Claude Code running on the user's Linux VPS.** Your job: detect whether
BL4CK RMM is already installed, then take the correct branch:

- **Not installed** → do a fresh install (§B)
- **Installed** → update it to the latest release (§C)

Start at §A. Do not guess which branch applies — run the detection.
Do not skip verification (§D). Never destroy data without an explicit backup.

---

## §A — Detect current state (ALWAYS run this first)

```bash
# Canonical install dir for this fork is /opt/bl4ck.
# Legacy/upstream installs may live at /opt/breeze — check both.
for d in /opt/bl4ck /opt/breeze; do
  [ -d "$d" ] && echo "FOUND: $d" && ls -la "$d" | head -20
done

# Are containers running?
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}' 2>/dev/null \
  | grep -Ei 'bl4ck|breeze' || echo "no BL4CK containers running"

# What version does a live API report?
curl -sf http://localhost:3000/health 2>/dev/null | head -c 300; echo
```

Decide:

| Observation | Branch |
|---|---|
| No `/opt/bl4ck` **and** no `/opt/breeze`, no containers | **§B — fresh install** |
| Directory exists with a `docker-compose.yml` and/or containers present | **§C — update** |
| Directory exists but is empty / half-finished, or compose is broken | **STOP.** Report findings and ask the user whether to repair or wipe. Point them at `deploy/RESET-AND-REINSTALL.md` — do not wipe on your own initiative. |

Report what you found to the user in one short paragraph **before** proceeding.

---

## §B — Fresh install

Follow **`deploy/DEPLOY-WITH-CLAUDE.md`** in this repo, top to bottom. It is the
authoritative fresh-install playbook (prerequisites, clone to `/opt/bl4ck`,
`deploy/install.sh`, Caddy/HTTPS, first admin).

Two things it needs — collect them first:

- **Domain** with a DNS **A record** already pointing at this VPS
  (`dig +short <domain>` must print this box's public IP), and ports **80/443** open.
- **Admin email** for the first dashboard login + Let's Encrypt.

After the install completes, still run **§D — verification**, and additionally set
the enrollment variables in §C.2 so installers behave as intended from day one.
A fresh install applies all migrations from scratch, so §C.1's backup does not apply.

---

## §C — Update an existing install

Target: latest `main` (currently **v0.102.0**).

Set the install dir once and reuse it:

```bash
BL4CK_DIR=/opt/bl4ck            # or /opt/breeze if that's what §A found
cd "$BL4CK_DIR"
```

### C.1 — Back up FIRST. Non-negotiable.

Two migrations in the v0.94 → v0.102 range cannot be undone:
`2026-07-12-drop-file-transfers.sql` is destructive, and v0.95.0 irreversibly
deletes legacy plaintext refresh tokens.

```bash
cp .env ".env.bak-$(date +%F)"

docker compose exec -T postgres pg_dump -U breeze breeze \
  | gzip > "/root/bl4ck-backup-$(date +%F).sql.gz"

ls -lh /root/bl4ck-backup-*.sql.gz
```

**Confirm the dump exists and is non-zero before continuing.** If `pg_dump` fails,
STOP and report — do not proceed to `docker compose up`.

Size the heaviest migration so you can warn about downtime:

```bash
docker compose exec -T postgres psql -U breeze -d breeze \
  -c "SELECT count(*) FROM refresh_token_families;"
```

A large count means `2026-07-15-auth-epochs-and-family-expiry.sql` (unbatched
`UPDATE` + `SET NOT NULL` in one transaction) will take a while.

### C.2 — Required environment variables

Add any that are missing to `$BL4CK_DIR/.env`. **A value in `.env` is not enough —
it must also appear in the `api` service's `environment:` block in
`docker-compose.yml`.** Compose only interpolates what is listed there.

```bash
# Blocks boot if missing (v0.97.0+). Must decode to >=32 bytes.
# Must NOT reuse JWT_SECRET.
grep -q '^PARTNER_API_CURSOR_SIGNING_KEY=' .env \
  || echo "PARTNER_API_CURSOR_SIGNING_KEY=$(openssl rand -base64 48)" >> .env
```

| Variable | Why | Value |
|---|---|---|
| `PARTNER_API_CURSOR_SIGNING_KEY` | **Blocks boot** | generated above |
| `DATABASE_URL_APP` *or* `BREEZE_APP_DB_PASSWORD` *or* `POSTGRES_PASSWORD` | **Blocks boot** (v0.95.0). `AUTO_MIGRATE=false` does not skip this | existing app-role password |
| `CHILD_ENROLLMENT_KEY_MAX_USAGE` | Reusable installers | `unlimited` |
| `CHILD_ENROLLMENT_KEY_TTL_MINUTES` | ⚠️ compose defaults to **1440**; set explicitly or you silently get 24h | `525600` |
| `INSTALLER_BOOTSTRAP_TOKEN_TTL_MINUTES` | Same trap | `525600` |
| `ENROLLMENT_KEY_CLEANUP_ENABLED` | Nightly sweep | `true` |
| `ENROLLMENT_KEY_PURGE_AFTER_DAYS` | Purge horizon | `7` |
| `OFFBOARDING_DRAIN_WINDOW_HOURS` | Make it visible in config | `72` |

Verify these already exist (required before this upgrade too):
`RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS`, `IS_HOSTED` (`false` for self-hosted),
`REDIS_PASSWORD`, `JWT_SECRET`, `APP_ENCRYPTION_KEY`.

**Do NOT enable** opt-in features that were off before —
`M365_CUSTOMER_GRAPH_READ_ONBOARDING_ENABLED`, `M365_GRAPH_ACTIONS_TOOLS_ENABLED`,
PAM actuator. All default off; none are mandatory.

### C.3 — Warn the user before restarting anything

v0.95.0 is disruptive. Say so plainly and get a go-ahead if this is business hours:

- **Every logged-in user is signed out** (new token claims, no silent-refresh recovery).
- **Legacy refresh tokens are deleted and grants revoked** — every MCP/OAuth client must re-authorize. Irreversible.
- **Every M365 ticket mailbox drops to `reauth_required`** and needs manual per-mailbox re-consent.
- The API **hard-fails on boot if the DB role is `SUPERUSER`/`BYPASSRLS`**.

### C.4 — Pull and restart

```bash
cd "$BL4CK_DIR"
git fetch origin
git log --oneline HEAD..origin/main | head    # show the user what's landing
git pull --ff-only origin main

docker compose pull api web binaries-init
docker compose up -d binaries-init api web

docker compose logs -f api | head -150
```

If `git pull --ff-only` refuses, the droplet has local commits. **STOP** — report
the divergence; do not force or reset.

Watch the logs for: config-validation refusal, migration checksum mismatch,
missing-env-var refusal. If the API crash-loops, capture the first 50 lines of the
error and report before retrying.

### C.4b — Known failure modes (all seven were hit on the 2026-07-28 upgrade)

Read this **before** you start debugging anything. Every item below cost real time
on the first v0.102.0 upgrade. Check them proactively rather than rediscovering
them from logs — that is what made the first run expensive.

| Symptom | Cause | Fix |
|---|---|---|
| `pnpm build` fails in `apps/web` on `compute-uninstall-sha256.ts` | Upstream's `prebuild` hook referenced a file this fork removed | **Fixed in repo.** If you still hit it, your checkout predates the fix — `git pull` again |
| Services can't resolve each other by name after restart | Compose service aliases don't re-register on an incremental swap | `docker compose down` then `docker compose up -d` (**never** `down -v` — that deletes volumes) |
| API boots but RLS / `breeze_app` errors | `DATABASE_URL_APP` left as a **localhost placeholder** | A placeholder is worse than absent. Either unset it and set `BREEZE_APP_DB_PASSWORD` (derived mode), or make it a real reachable URL |
| Footer / API reports `0.0.0-dev` | A binaries-init **stub** (from `setup.sh` or a dev/ci override) hardcodes `0.0.0-dev` into `/target/VERSION` | Ensure the real `binaries-init` service runs and `BREEZE_VERSION` is set in `.env` |
| Dashboard links point at `breeze.yourdomain.com` | `.env` copied `.env.example` placeholders verbatim | Set `PUBLIC_APP_URL` and `DASHBOARD_URL` to the real HTTPS domain |
| Installer / agent download returns **500** | v0.102's download route presigns S3; with no MinIO it targets `localhost:9000` and hard-500s | Disable S3 so files serve from the volume; this also clears the "S3 sync errors" in logs |
| Bootstrap admin recreated, or warnings on boot | `BREEZE_BOOTSTRAP_ADMIN_EMAIL` / `_PASSWORD` left populated after first login | Blank both in `.env` **and** the running container once the admin exists |

**Budget note.** The expensive part of an upgrade is Docker **build** output, not
the app itself. Prefer `docker compose pull` over building from source whenever
images are available, and never stream a full build log into your context —
redirect it to a file and `tail` only the failing section:

```bash
docker compose build web > /tmp/build.log 2>&1 || tail -40 /tmp/build.log
```

### C.5 — Agent fleet

🔴 **Never promote the v0.100.0 Windows agent.** Its watchdog kills healthy agents
and leaves them permanently STOPPED in FAILOVER — symptom: *"it installed, but the
service is not running."* Promote **v0.101.0 or newer** only. The v0.99.0 Windows
agent is also degraded. With `AGENT_AUTO_PROMOTE=false` this is a deliberate
action, so deploying the server alone is not enough.

---

## §D — Verification (run for BOTH branches)

Report each as pass/fail. Do not declare success on a partial pass.

```bash
# 1. Version
curl -sf https://<domain>/health | jq .version     # expect "0.102.0" after an update

# 2. Containers healthy
docker compose ps

# 3. Migrations applied, no checksum mismatch
docker compose logs api | grep -iE 'migration|checksum' | tail -20
```

4. Log in to the dashboard; sidebar version indicator is green.
5. Existing devices still check in (skip on fresh install).
6. Device approve / quarantine actions work.

7. **The installer test — this is the one that matters.** Download **one**
   installer from the dashboard, enroll **3+ devices back to back** on it, then:

```bash
docker compose exec -T postgres psql -U breeze -d breeze -c "
SELECT max_usage, expires_at FROM installer_bootstrap_tokens
  ORDER BY created_at DESC LIMIT 1;"
-- expect: max_usage = 1000, expires_at ~ now() + 365 days

docker compose exec -T postgres psql -U breeze -d breeze -c "
SELECT max_usage FROM enrollment_keys
  WHERE name LIKE '%link%' ORDER BY created_at DESC LIMIT 1;"
-- expect: NULL  (unlimited reuse)
```

If `expires_at` is ~1 hour instead of ~1 year, or `max_usage` is `1` instead of
`1000` / `NULL`, **something clamped it — report immediately and do not hand the
installer to the user.**

---

## §E — Rollback (update branch only)

```bash
cd "$BL4CK_DIR"
cp ".env.bak-<date>" .env
git log --oneline -5                 # find the pre-update commit
git checkout <pre-update-sha>
docker compose pull api web binaries-init
docker compose up -d binaries-init api web
```

⚠️ **Code rollback alone is not enough once migrations have run.**
`drop-file-transfers` is destructive and the refresh-token deletion cannot be
backfilled. A true rollback requires restoring the dump from §C.1:

```bash
gunzip -c /root/bl4ck-backup-<date>.sql.gz \
  | docker compose exec -T postgres psql -U breeze -d breeze
```

---

## §F — Rules for you, Claude

- **Never** run `docker compose down -v`, `docker volume rm`, or drop a database. Those destroy tenant data.
- **Never** `git push --force`, `git reset --hard`, or `git checkout` over uncommitted droplet changes.
- **Never** proceed past a failed backup, a failed migration, or a crash-looping API.
- If `.env` already contains a variable, **do not overwrite it** — report that it is present (never print secret values) and ask.
- `BREEZE_*` env vars, `@breeze/*` packages, the `breeze_app` Postgres role, `breeze_migrations`, and `breeze-*` container names are **infrastructure and intentionally not rebranded**. Do not "fix" them — renaming any breaks the deployment.
- When unsure, stop and ask. A half-applied upgrade is worse than a deferred one.

Full background: `updated-code-docs/UPGRADE-v0.102.0-RUNBOOK.md`.
