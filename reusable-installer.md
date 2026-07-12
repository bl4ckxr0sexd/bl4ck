# Reusable & Long-Lived Installers

This document explains everything this fork changes versus stock
[LanternOps/breeze](https://github.com/lanternops/breeze) `v0.94.0`, why each
change is needed, and how installers behave as a result.

**Goal:** one downloaded Windows/macOS installer that can enroll **many
machines** and stays valid for **~1 year**, instead of the stock behavior of
**one device, one hour**.

---

## 1. Background — how a Breeze installer enrolls a device

Enrollment happens through a three-level chain:

```
Parent enrollment key      (created in Settings / "Add device")
        │  at download time, mints…
        ▼
Bootstrap token            (embedded inside the .msi / .pkg you download)
        │  when the installer runs on a PC, it consumes the token, which mints…
        ▼
Child enrollment key       (per-device; this is what the agent enrolls with)
```

Two independent limits decide how far one downloaded installer goes:

| Limit | Lives on | Stock default | Effect when hit |
|---|---|---|---|
| **max usage** | bootstrap token | `1` | installer refuses after the 1st machine |
| **expiry (TTL)** | bootstrap token, capped by parent key | ~1 hour | installer stops working after ~1h |

So out of the box a downloaded installer is single-use and short-lived. This
fork raises **both** limits.

---

## 2. What we changed

### 2a. Code — `apps/api/src/routes/enrollmentKeys.ts`

Introduced a deployment-level default read from the environment:

```ts
const CHILD_ENROLLMENT_KEY_MAX_USAGE: number | null = (() => {
  const raw = process.env.CHILD_ENROLLMENT_KEY_MAX_USAGE;
  if (!raw || raw.toLowerCase() === "unlimited") return null; // null = no cap
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
})();
```

Then replaced the hard-coded `maxUsage: 1` with this default in the paths that
mint per-device child keys and the installer-download bootstrap token:

- child key on invite/short-link download → `maxUsage: CHILD_ENROLLMENT_KEY_MAX_USAGE`
- key-create route default → `input.maxUsage ?? CHILD_ENROLLMENT_KEY_MAX_USAGE`
- installer-download handler → the `count` query field now defaults to the env
  value when omitted, instead of `1`.

Because `installer_bootstrap_tokens.max_usage` is a `NOT NULL` column with a
`>= 1` check (it can't be `null`/unlimited like child keys can), "unlimited" is
mapped to a large finite cap for the *token* only:

```ts
const BOOTSTRAP_TOKEN_UNLIMITED_MAX_USAGE = 100000;
const bootstrapTokenMaxUsage = childMaxUsage ?? BOOTSTRAP_TOKEN_UNLIMITED_MAX_USAGE;
```

**Important design rule:** the env var is only a **default**. A device count or
expiry a user explicitly enters at installer-creation time still wins — the
default applies **only** when the field is left blank. Nothing silently
overrides an explicit value.

### 2b. Configuration — the four env vars

| Variable | Value | Meaning |
|---|---|---|
| `CHILD_ENROLLMENT_KEY_MAX_USAGE` | `unlimited` | per-device child keys carry no usage cap |
| `CHILD_ENROLLMENT_KEY_TTL_MINUTES` | `525600` | child key lifetime = 365 days |
| `ENROLLMENT_KEY_DEFAULT_TTL_MINUTES` | `525600` | parent-key default lifetime = 365 days |
| `INSTALLER_BOOTSTRAP_TOKEN_TTL_MINUTES` | `525600` | embedded installer token = 365 days |

All four are set automatically by [`setup.sh`](./setup.sh).

### 2c. The critical gotcha — env vars must be mapped into compose

> This was the single biggest trap. Putting the values in `.env` is **necessary
> but not sufficient.**

The stock `docker-compose.yml` does **not** list these four variables in the
API service's `environment:` block. The API only reads config from that block,
so values sitting in `.env` were **silently ignored** and the API kept falling
back to code defaults (1-hour parent key, 24-hour token). Installers stayed
short-lived even though `.env` "looked right".

The fix: map them in `docker-compose.override.yml` (which `setup.sh` generates):

```yaml
services:
  api:
    environment:
      CHILD_ENROLLMENT_KEY_MAX_USAGE: ${CHILD_ENROLLMENT_KEY_MAX_USAGE:-unlimited}
      CHILD_ENROLLMENT_KEY_TTL_MINUTES: ${CHILD_ENROLLMENT_KEY_TTL_MINUTES:-1440}
      ENROLLMENT_KEY_DEFAULT_TTL_MINUTES: ${ENROLLMENT_KEY_DEFAULT_TTL_MINUTES:-60}
      INSTALLER_BOOTSTRAP_TOKEN_TTL_MINUTES: ${INSTALLER_BOOTSTRAP_TOKEN_TTL_MINUTES:-1440}
```

The fallback values equal the stock code defaults, so an unset variable stays
safe (never `Number("") = 0`).

### 2d. MSI download fix — `BINARY_SOURCE=github`

Symptom: **"MSI not available"** when downloading the Windows installer.

Cause: `BINARY_SOURCE=local` reads agent binaries from disk, but a from-source
build only stages **empty stub** binary directories — there is no MSI to serve.

Fix: `BINARY_SOURCE=github` (also the base-compose default) makes the API serve
the official signed `v0.94.0` installer assets from the GitHub release CDN and
verify them against the Ed25519 release manifest
(`RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS`, a public key shipped in `.env.example`).
`setup.sh` sets this.

---

## 3. Resulting behavior

One installer downloaded from a fork instance:

- **Reusable** — enrolls up to the device count chosen at download time (up to
  1000 via the token cap; child keys themselves are uncapped). Each machine
  consumes one slot and mints its own child key.
- **Long-lived** — valid ~365 days. Save the file and reuse it for a year.

Verified against the database after the fix (times from the working instance):

```
installer_bootstrap_tokens
 platform | max_usage | consumed | expires_at          | lifetime
----------+-----------+----------+---------------------+------------------
 windows  |      1000 |        2 | 2027-07-11 23:24:47 | 364 days 23:59:59   <- reusable + 1yr
 windows  |      1000 |        0 | 2026-07-12 00:15:08 | ~1 hour             <- pre-fix token
```

The jump from a ~1-hour lifetime (pre-fix) to 364 days (post-fix), and
`consumed` climbing from 1 → 2 as a second PC enrolled from the *same* file, is
the direct proof the chain works end-to-end.

---

## 4. How to use

1. Deploy with [`setup.sh`](./setup.sh) (sets all four vars + `BINARY_SOURCE`
   + generates the compose override).
2. In the dashboard, create an installer under **Add device** — optionally set a
   device count; leave it blank to use the unlimited default.
3. Download the `.msi` / `.pkg` **once** and hand it to as many machines as your
   count allows, for up to a year.

---

## 5. Caveats — read these

- **One file = one token.** Each download embeds its own bootstrap token tied to
  the count chosen at that moment. Different downloads are **not**
  interchangeable.
- **Don't re-run the same file on a machine that's already enrolled.** That is
  the "error" you may see — it's expected. Hand the file to *new* machines
  instead. (Re-running only wastes a usage slot at best.)
- **Pre-fix installers stay dead.** Any installer downloaded before this fix was
  built with a 1-hour token and cannot be revived — download a fresh one.
- **Raising a limit does not retroactively extend already-issued tokens.** New
  behavior applies to installers downloaded *after* the API picked up the env
  mapping.

---

## 6. File reference

| File | Role |
|---|---|
| `apps/api/src/routes/enrollmentKeys.ts` | the code patch (§2a) |
| `setup.sh` | full installer; sets the vars, writes the compose override, builds & starts |
| `docker-compose.override.yml` | generated per-host; maps the four vars into the API (§2c) |
| `.env` | holds the four values + `BINARY_SOURCE=github` (gitignored — never committed) |
| `README.md` | quick start + summary |
