# BL4CK RMM — Upgrade Runbook: v0.94.0 → v0.102.0

Branch: `upgrade/v0.102.0` · Rollback tag: `pre-upgrade-v0102-2026-07-28`
Traverses 13 upstream releases, 330 commits, 81 new migrations.

> Everything here was verified against the committed code on the upgrade branch.
> Claims that can only be confirmed in production are marked **[verify after deploy]**.

---

## 1. Does the installer still behave the same? — Yes, and the 1-year finally works

| Property | Before (v0.94.0) | After (v0.102.0) |
|---|---|---|
| Devices per downloaded installer | 1000 | **1000** — unchanged |
| Installer validity | *Advertised* 365 days | **365 days — actually delivered** |
| Child enrollment key reuse | Unlimited (`maxUsage: null`) | **Unlimited** — unchanged |
| Windows-only | Yes | Yes |
| MSI + silent EXE | Yes | Yes |

Source of truth, `apps/api/src/routes/enrollmentKeys.ts`:

```ts
const INSTALLER_FIXED_MAX_DEVICES = 1000;
const INSTALLER_FIXED_TTL_MINUTES = 525600; // 365 days
```

The Add Device UI exposes no count or expiry control; any `count`/`ttlMinutes`
left in the query string is deliberately ignored.

### The bug this upgrade fixes

Before this merge the bootstrap token's expiry was `min(parent.expiresAt, …)`.
The Add Device modal deliberately mints a **transient ~60-minute parent key**, so
every "1-year installer" actually stopped working after about an hour. Upstream
#2775 removes that bound; the token's own expiry is now the sole authority.

So: **the 1000 devices are the same, and the 1 year is what it always claimed to
be but was not.**

### Why it cannot silently regress

Four independent things had to line up, all verified in committed code:

1. **`maxUsage: null` = unlimited is native upstream behavior.**
   `routes/agents/enrollment.ts:120` — `(maxUsage IS NULL OR usageCount < maxUsage)`;
   `:177` — `if (maxUsage !== null && usageCount >= maxUsage)`. Upstream's new
   `maxEnrollmentLinkTtlMinutes` ceiling bounds **expiry only** — it never reads
   or writes `maxUsage`.

2. **The 365-day TTL cannot be clamped.** The fixed installer path passes
   `bypassPartnerTtlCap: true`, so lowering a partner cap in the new Settings UI
   cannot retroactively shorten installers already shipped as signed media.

3. **The nightly purge cannot cascade the token away.**
   `jobs/enrollmentKeyCleanup.ts:107` exempts any parent key holding a live,
   unexhausted token: `consumed_count < max_usage`. Our token's `max_usage` is a
   **finite 1000**, so that comparison works. If it were `NULL` the SQL would
   evaluate to `NULL` (not `true`), the exemption would be lost, and the 7-day
   purge would `ON DELETE CASCADE` the token — killing the installer.
   **Do not "improve" the bootstrap token's `max_usage` to unlimited.**

4. **The knob now actually reaches the container.**
   `CHILD_ENROLLMENT_KEY_MAX_USAGE` was documented in `.env.example` but was
   **never mapped in `docker-compose.yml`** — setting it in `.env` was a silent
   no-op. Now mapped, defaulting to `unlimited`, guarded by the
   `envComposeParity` contract test.

### Two clocks — don't confuse them

| Object | Governs | Value |
|---|---|---|
| **Bootstrap token** (embedded in the installer filename) | How many devices, and for how long, one downloaded file can enroll | 1000 uses / 365 days |
| **Child enrollment key** (minted per redemption) | The short-lived credential a device uses to finish enrolling | `CHILD_ENROLLMENT_KEY_TTL_MINUTES`; `maxUsage` unlimited |

The child key only has to live long enough to complete one enrollment, so the
compose default of 1440 minutes is ample. It does **not** cap the installer.

### One caveat that is genuinely different

The **public short-link path** (`/s/:code`) issues a bootstrap token with
`maxUsage: 1`. That is pre-existing fork behavior, unchanged by this upgrade, and
is *not* the same as the dashboard "Download installer" flow. For a reusable
file, use the dashboard download.

---

## 2. Pre-flight

### 2.1 Back up the database — non-negotiable

Two migrations in this range are dangerous:

- `2026-07-12-drop-file-transfers.sql` — **destructive**; drops the table + enums.
- `2026-07-15-auth-epochs-and-family-expiry.sql` — unbatched `UPDATE` +
  `SET NOT NULL` on `refresh_token_families` in one transaction.

```bash
ssh root@<host> "cd /opt/breeze && \
  docker compose exec -T postgres pg_dump -U breeze breeze | gzip > /root/bl4ck-pre-0102-$(date +%F).sql.gz && \
  ls -lh /root/bl4ck-pre-0102-*.sql.gz"
```

Confirm the file exists and is non-zero before continuing.

Size the risky migration first:

```bash
docker compose exec -T postgres psql -U breeze -d breeze \
  -c "SELECT count(*) FROM refresh_token_families;"
```

A large table means a long migration — batch the backfill manually if needed.

### 2.2 Required environment variables

Add to `/opt/breeze/.env` **and** confirm each is mapped in the `api` service
`environment:` block. A value in `.env` alone does nothing.

| Variable | Why | Value |
|---|---|---|
| `PARTNER_API_CURSOR_SIGNING_KEY` | **Blocks boot** (v0.97.0+). Must decode to ≥32 bytes; must NOT reuse `JWT_SECRET` | `openssl rand -base64 48` |
| `DATABASE_URL_APP` *or* `BREEZE_APP_DB_PASSWORD` *or* `POSTGRES_PASSWORD` | **Blocks boot** (v0.95.0). `AUTO_MIGRATE=false` does not skip this check | existing app-role password |
| `OFFBOARDING_DRAIN_WINDOW_HOURS` | Set explicitly so it is visible in config | `72` |
| `CHILD_ENROLLMENT_KEY_MAX_USAGE` | Reusable installers | `unlimited` |
| `CHILD_ENROLLMENT_KEY_TTL_MINUTES` | ⚠️ compose defaults this to **1440**; `.env.example` documents **525600**. Set it explicitly or you inherit 1440 | `525600` |
| `INSTALLER_BOOTSTRAP_TOKEN_TTL_MINUTES` | Same discrepancy — compose default 1440 | `525600` |
| `ENROLLMENT_KEY_CLEANUP_ENABLED` | Nightly expired-key sweep | `true` |
| `ENROLLMENT_KEY_PURGE_AFTER_DAYS` | Purge horizon after expiry | `7` |

Already required, carried forward — verify present:
`RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS`, `IS_HOSTED` (`false` for self-hosted),
`REDIS_PASSWORD`, `JWT_SECRET`, `APP_ENCRYPTION_KEY`.

**Do NOT enable** the opt-in features introduced in this range. All default off
and none are mandatory: `M365_CUSTOMER_GRAPH_READ_ONBOARDING_ENABLED`,
`M365_GRAPH_ACTIONS_TOOLS_ENABLED`, PAM actuator.

### 2.3 Pull the updated compose file

v0.99.0 (#2712) threads **36 documented `.env` variables** into the API container
that were previously silently inert. If you maintain a forked
`docker-compose.yml` on the droplet you will not inherit those mappings — diff
the repo's compose against the droplet's before deploying.

---

## 3. Deploy

```bash
ssh root@<host> "cd /opt/breeze && \
  cp .env .env.bak-pre-0102 && \
  sed -i 's/^BREEZE_VERSION=.*/BREEZE_VERSION=0.102.0/' .env && \
  docker compose pull api web binaries-init && \
  docker compose up -d binaries-init api web"

ssh root@<host> "cd /opt/breeze && docker compose logs -f api | head -150"
```

Watch for: config-validation refusal on boot, migration checksum mismatch,
missing-env-var refusal.

`BREEZE_VERSION` keeps its name deliberately — the env var is infrastructure and
was **not** rebranded. Renaming it would break every existing deployment.

---

## 4. Verification

Run in order. Item 5 is the one that matters most to this fork.

1. `curl -sf https://v2.kd3.pro/health | jq .version` → `"0.102.0"`
2. API log shows all migrations applied, no checksum mismatch
3. Log in; sidebar version indicator green
4. Existing devices still check in
5. **Download one installer from the dashboard and enroll 3+ devices back to back.** All must succeed. Then confirm in psql:
   ```sql
   SELECT max_usage, expires_at FROM installer_bootstrap_tokens
     ORDER BY created_at DESC LIMIT 1;
   -- expect: max_usage = 1000, expires_at ≈ now() + 365 days

   SELECT max_usage FROM enrollment_keys
     WHERE name LIKE '%link%' ORDER BY created_at DESC LIMIT 1;
   -- expect: NULL  (unlimited)
   ```
   The `expires_at` check is the proof that no partner cap truncated you.
6. `/partners/me` populates the UI with no blank fields (the response was
   narrowed to a column allowlist in #2783 / #2779 / #2800)
7. Agent inventory report ingests (the #2786 deadlock fix path)
8. Device approve / quarantine work
9. Windows agent auto-updates cleanly — **read §5.1 first**

---

## 5. Behavior changes operators must know

### 5.1 🔴 Never promote the v0.100.0 Windows agent

A fresh v0.100.0 install could enroll and heartbeat normally, then be **killed
five times in nine minutes and left permanently STOPPED in FAILOVER**. Six
independent defects combined. Operator symptom: *"it installed, but the service
is not running after."*

**Go straight to the v0.101.0+ agent.** The fix is agent-side, so deploying the
v0.102.0 server is not sufficient — with `AGENT_AUTO_PROMOTE=false` you must
promote deliberately. The v0.99.0 Windows agent is also degraded (state-file race
causing "Agent Silent"); v0.101.0 is the first clean build in this range.

### 5.2 v0.95.0 is disruptive — plan a maintenance window

- **Every logged-in user is signed out.** New token claims; no silent-refresh
  recovery, no kill switch.
- **Legacy plaintext refresh tokens are deleted and grants revoked.** One-way,
  cannot be backfilled. Every MCP/OAuth client must re-authorize.
- **Every M365 ticket mailbox drops to `reauth_required`** and needs manual
  Partner Admin re-consent, per mailbox.
- The API **hard-fails on boot if it detects a `SUPERUSER`/`BYPASSRLS` DB role.**
- Previously-inert policies now enforce: SSO `email_verified:false` rejection,
  MFA `allowedMethods`, `requireMfa` session gate, portal `enable_tickets` gate,
  backup exclusion globs.

### 5.3 Enrollment lifecycle

- Installer bootstrap tokens **no longer expire with their parent key**.
- **Shortening a parent key's expiry no longer kills outstanding installers.**
  That previously worked as a kill switch. To revoke now you must **delete the
  key** (`parent_enrollment_key_id` is `ON DELETE CASCADE`). This is a genuine
  loss of capability — know it before you need it.
- Expired enrollment keys are swept and purged after 7 days.
- ⚠️ **Do not set `maxEnrollmentLinkTtlMinutes` below 525600** in the new
  partner/org Settings UI. The cap is partner-locked and an org cannot raise it.
  Our fixed installer path bypasses it, but every other mint path is clamped.

### 5.4 Other

- **v0.99.0:** quotes sent before the upgrade have no recipient rows and **fail
  closed** — re-send any open quote. The mobile app must be updated for approver
  device registration. Posture reports score >30-day-stale readings as "unknown",
  so compliance percentages will shift.
- **v0.100.0:** Remediate now schedules patches it previously reported as "no
  available patch" — expect more remediation jobs to fire.
- **v0.101.0:** portal cookies honor proxy posture; over plain HTTP they are
  issued without `Secure` so login works.
- **v0.102.0:** new operator-initiated `offboarding` tenant status; a reaper
  flips the tenant to `churned` after `OFFBOARDING_DRAIN_WINDOW_HOURS`.

---

## 6. Rollback

```bash
# Code — main was never modified
git checkout main

# Droplet
ssh root@<host> "cd /opt/breeze && \
  cp .env.bak-pre-0102 .env && \
  docker compose pull api web binaries-init && \
  docker compose up -d binaries-init api web"
```

⚠️ **The database is not rollback-safe.** `drop-file-transfers` is destructive and
the v0.95.0 refresh-token deletion cannot be backfilled. Rolling the code back
after a successful migration requires restoring the dump from §2.1.

---

## 7. Fork-specific defects fixed in this merge

Found while verifying; all ours, not upstream's:

- **Tenant-isolation leak.** Fork-original `script_connect_runs` was missing from
  `CORE_DEVICE_ORG_DENORMALIZED_TABLES`. A device move-org left stale `org_id`
  rows readable by the *old* org under RLS and invisible to the new one.
- **Agent stop guard bypassable.** `AGENT_SERVICE_NAMES` omitted the `bl4ck`
  names, so a tech could stop the agent service from Services Manager and
  disconnect the device.
- **Corrupted reliability scores.** `isBreezeSelfServiceFailure` matched only
  `breeze`, so every `Bl4ckAgent`/`Bl4ckWatchdog` auto-update restart was scored
  as a customer device failure, skewing scores and MTBF.
- **Uninstall cleanup silently no-opped.** `remove-windows-task.ps1` used
  `"\\BL4CK\\"`; PowerShell does not escape backslashes, so it never matched the
  registered task.

---

## 8. Rebrand scope — deliberate

User-visible strings only: 927 occurrences across 7 locales, API email/copy, and
web source. The following are **load-bearing infrastructure and were deliberately
left as `breeze`** — renaming any of them breaks the deployment:

`BREEZE_*` env vars · `@breeze/*` workspace packages · `breeze_app` Postgres role
(every RLS policy references it) · `breeze_migrations` · `breeze_has_*` /
`breeze.scope` RLS helpers · `breeze-postgres` / `breeze-redis` containers ·
`github.com/breeze-rmm/agent` Go module path · `LanternOps` attribution.

`git grep -i breeze` returning hits is therefore **expected and correct**.
