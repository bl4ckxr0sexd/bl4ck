<p align="center">
  <img src="docs/assets/breeze-logo.png" alt="Breeze" width="120" />
</p>

<h1 align="center">Breeze</h1>

<p align="center">
  <strong>The open source, AI-native RMM.</strong><br/>
  Monitor, manage, and remediate — with an AI brain built in.
</p>

<p align="center">
  <a href="https://breezermm.com/features/"><strong>▶ Live Demos</strong></a> •
  <a href="#security">Security</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#features">Features</a> •
  <a href="#ai-brain">AI Brain</a> •
  <a href="#architecture">Architecture</a> •
  <a href="#roadmap">Roadmap</a> •
  <a href="#contributing">Contributing</a> •
  <a href="#license">License</a>
</p>

<p align="center">
  <a href="https://github.com/lanternops/breeze/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue" alt="License" /></a>
  <a href="https://github.com/lanternops/breeze/releases"><img src="https://img.shields.io/github/v/release/lanternops/breeze" alt="Release" /></a>
  <a href="https://breezermm.com/discord"><img src="https://img.shields.io/badge/discord-join-7289da" alt="Discord" /></a>
</p>

<p align="center">
  <img src="docs/breeze-ai-demo.gif" alt="Breeze AI Demo — Check a device's health" width="800" />
</p>

<p align="center">
  <em>Want to click around?</em> <a href="https://breezermm.com/features/"><strong>Interactive feature demos at breezermm.com/features</strong></a> (e.g. <a href="https://breezermm.com/features/remote-access/">Remote Access</a>).
</p>

---

## ⚡ About this fork

This is a self-hosting fork of [LanternOps/breeze](https://github.com/lanternops/breeze) `v0.94.0` with two changes aimed at MSPs who hand out one installer to many machines:

- **Reusable installers** — a single downloaded Windows/macOS installer can enroll **many devices** instead of dying after the first install.
- **Long-lived installers** — installers stay valid for **~365 days** instead of the stock 1 hour, so you can save one file and reuse it.

Everything else is stock Breeze (AGPL-3.0). See [What changed](#what-changed-in-this-fork) for the exact diff and knobs.

### One-command setup

On a fresh Docker host:

```bash
git clone https://github.com/bl4ckxr0sexd/bl4ck.git breeze && cd breeze
./setup.sh                 # interactive: asks for domain, ACME email, admin login
```

or fully non-interactive:

```bash
./setup.sh \
  --domain rmm.example.com \
  --acme-email you@example.com \
  --admin-email you@example.com \
  --admin-password 'YourStrongPassword16+' \
  --non-interactive
```

`setup.sh` is idempotent and handles the whole install:

1. Checks prerequisites (Docker, Docker Compose v2, OpenSSL).
2. Detects CPU arch and builds for `linux/amd64` or `linux/arm64` automatically.
3. Creates `.env` from `.env.example` and **generates every required secret** (JWT, encryption keys, peppers, Postgres/Redis passwords, TURN secret). Re-running preserves existing secrets — it never rotates your keys.
4. Applies the reusable + long-lived installer defaults.
5. Generates `docker-compose.override.yml` (builds images from source and maps the four enrollment-key env vars the base compose file doesn't).
6. Builds, starts the stack, and waits for the API to report healthy.

**Requirements:** Docker Engine + Compose v2, and (for a real TLS cert) a domain whose DNS points at the host with ports **80** and **443** open. Use `--domain localhost` to test with a self-signed cert.

**After first login:** remove `BREEZE_BOOTSTRAP_ADMIN_EMAIL` and `BREEZE_BOOTSTRAP_ADMIN_PASSWORD` from `.env`, then `docker compose up -d`, so the bootstrap credential isn't left on disk.

### What changed in this fork

| Area | Stock Breeze | This fork |
|---|---|---|
| Installer reuse | 1 device per installer | Unlimited devices per installer (`CHILD_ENROLLMENT_KEY_MAX_USAGE=unlimited`) |
| Installer lifetime | ~1 hour | ~365 days (`*_TTL_MINUTES=525600`) |

- **Code:** `apps/api/src/routes/enrollmentKeys.ts` — the per-device child enrollment key and the installer-download bootstrap token now honour `CHILD_ENROLLMENT_KEY_MAX_USAGE` and the raised TTL defaults, instead of the hard-coded `maxUsage: 1` / 1-hour expiry. An explicit device-count or expiry entered at installer-creation time still wins — the env var is only the default when the field is left blank.
- **Config** (set by `setup.sh`, mapped into the API via `docker-compose.override.yml`):

  ```env
  CHILD_ENROLLMENT_KEY_MAX_USAGE=unlimited      # per-device child keys carry no usage cap
  CHILD_ENROLLMENT_KEY_TTL_MINUTES=525600       # 365 days
  ENROLLMENT_KEY_DEFAULT_TTL_MINUTES=525600     # parent-key default = 365 days
  INSTALLER_BOOTSTRAP_TOKEN_TTL_MINUTES=525600  # embedded installer token = 365 days
  ```

  > These four vars **must** live in the API service's compose `environment:` block — the stock `docker-compose.yml` doesn't map them, so `.env` alone is ignored and the API silently falls back to the 1-hour/1-use defaults. `setup.sh` handles this for you.

> **Note:** one installer file embeds one token tied to the count chosen at download time. Re-running the *same* file on a machine that's already enrolled is expected to no-op/error — hand the file to *new* machines, or download a fresh one for a different device count.

---

## What is Breeze?

Breeze is a full-featured remote monitoring and management platform with AI built into its core — not bolted on as an afterthought.

Software features are exploding, but people can't keep up. Every RMM on the market adds more buttons, more tabs, more dashboards. Breeze takes a different approach: **an AI agent that actually uses the features for you.** It investigates alerts, remediates issues, documents what it did, and only bothers you when it needs a human decision.

Breeze is free, open source (AGPL-3.0), and designed to be self-hosted or [cloud-hosted at breezermm.com](https://breezermm.com).

### Why Breeze?

- **AI-native, not AI-added.** Every page has an AI assistant that can see what you see and take action using built-in tools. Not a chatbot — an agent.
- **Lightweight agent.** Single Go binary. Cross-platform. Minimal resource footprint. Your clients won't notice it's there.
- **Actually open source.** AGPL-3.0. Read every line. Fork it. Contribute. No bait-and-switch.
- **Multi-tenant from day one.** Built for MSPs managing multiple clients, not retrofitted from a single-tenant architecture.
- **Modern stack.** Not a legacy codebase with 15 years of technical debt. Clean, fast, extensible.

---

## Security

Breeze has privileged access to every device it manages. We take that seriously.

| Layer | What We Do |
|---|---|
| **Authentication** | Argon2id passwords, JWT with 15-min expiry, TOTP MFA, SHA-256 hashed tokens, email verification on signup |
| **Authorization** | RBAC with scope-based multi-tenancy, forced PostgreSQL row-level security on every tenant table — no app-layer-only fallback, even table owners can't bypass |
| **Encryption** | AES-256-GCM at rest, TLS 1.2+ in transit, HSTS preload, no plaintext secrets stored anywhere |
| **Agent hardening** | Bearer token auth (SHA-256 hashed), 0600 config file permissions, optional Cloudflare mTLS |
| **Rate limiting** | Redis sliding window on all auth endpoints and agent APIs — fail-closed if Redis is unavailable |
| **Input validation** | Zod schemas on every external input — API requests, WebSocket messages, query parameters |
| **AI safety** | Risk-classified action engine — dangerous operations require human approval, critical operations blocked entirely |
| **Supply chain** | 5 automated scanners in CI: CodeQL SAST, Gitleaks, npm audit, govulncheck, Trivy CVE scanning |
| **Audit trail** | Structured audit logging with actor tracking, org-scoped retention policies, S3 archival |
| **Operational** | Secret rotation runbooks, disaster recovery procedures (RTO < 1 hour, RPO < 15 minutes) |
| **Abuse controls** | Cross-tenant platform-admin suspend endpoint, email-verification gate on signup, fail-closed token revocation |

For the full security whitepaper, including SOC 2 alignment mapping, see **[Security Practices](docs/SECURITY_PRACTICES.md)**.

To report a vulnerability: **[security@lanternops.io](mailto:security@lanternops.io)** — see [SECURITY.md](SECURITY.md) for our disclosure policy.

---

## Features

### Device Management
- **Hardware & software inventory** — CPU, memory, storage, network, installed applications, versions
- **Real-time device health** — Health checks with configurable thresholds and alerting
- **Configuration policies** — Hierarchical policy management with feature links and per-assignment resolution
- **Advanced filtering** — Query your fleet with powerful filters across any device attribute
- **Network discovery** — ARP, ICMP, port, and SNMP scans to find unmanaged devices on each site
- **Custom fields & tags** — Extend device records with your own metadata
- **Configuration drift & change tracking** — Audit baselines, CIS hardening checks, software/peripheral policies

### Remote Access
- **Remote terminal** — Full shell access to managed devices
- **Remote file browser** — Browse, upload, and download files
- **Remote desktop** — Visual remote control of devices, multi-display, clipboard sync, computer-control automation
- **Native viewer & helper apps** — Tauri-based desktop apps for macOS and Windows
- **Activity monitoring** — See what's happening on a device in real time
- **TURN relay** — Built-in coturn for WebRTC traversal across NATs and firewalls

### Automation
- **Remote scripting** — Execute scripts (PowerShell, Bash, Python) across devices
- **Patch management** — Inventory, approve, and deploy OS and application patches; maintenance windows + update rings
- **Alerts & notifications** — Configurable alerts with severity classification, routing, webhook delivery
- **Playbooks** — Reusable remediation workflows
- **Deployments** — Push agents and software at scale
- **Watchdog** — Self-healing agent supervisor that auto-restarts on failure

### Backup & Recovery
- **Endpoint snapshot backup** — Restic-based snapshots to S3-compatible storage
- **Bare-metal recovery** — Full-disk restore for Windows endpoints
- **Hyper-V & SQL Server agents** — Application-aware backups
- **Cloud-to-cloud (M365)** — Email, OneDrive, SharePoint, Teams, calendar
- **Disaster recovery & verification** — Restore tests, encryption, retention policies

### Integrations
- **EDR** — SentinelOne and Huntress with risk-classified actions and incident correlation
- **PSA** — Connect to popular ticketing systems
- **MCP server** — Connect Claude.ai, ChatGPT, Cursor, or any MCP-aware AI agent over OAuth 2.1

### AI Brain (BYOK)
- **AI chat on every page** — Context-aware assistant that knows what you're looking at
- **Tool-equipped agent** — The AI doesn't just talk, it acts — querying devices, running diagnostics, executing remediations
- **Risk-classified actions** — Every AI action is validated against a risk engine before execution. Dangerous actions require human approval. Always.
- **Bring your own key** — Plug in your Anthropic API key and the brain works out of the box
- **External AI agents via MCP** — Or connect Claude.ai, ChatGPT, Cursor through the built-in MCP server with OAuth 2.1 + PKCE

> **🧠 [LanternOps Brain](https://lanternops.io)** — Want persistent memory, cross-tenant intelligence, automated playbooks, and compliance evidence generation? LanternOps is the managed AI brain for Breeze. Same RMM, smarter brain. [Learn more →](https://lanternops.io)

---

## Quick Start

### Option 1: Cloud Hosted (Easiest)

Skip infrastructure entirely. [Sign up at breezermm.com](https://breezermm.com) and have a fully managed Breeze instance in minutes.

### Option 2: Self-Hosted Guided Setup

Requires [Docker](https://docs.docker.com/get-docker/) and Docker Compose.

Run the guided setup from an empty directory where you want Breeze's generated `.env` and `docker-compose.yml` files to live:

```bash
mkdir breeze && cd breeze
curl -fsSLO https://raw.githubusercontent.com/lanternops/breeze/main/scripts/guided-setup.sh
chmod +x guided-setup.sh
./guided-setup.sh
```

The guided setup checks required commands, Docker Compose, CPU, RAM, and free disk space before generating configuration. It asks which Breeze release to install, downloads that release's `docker-compose.yml` and `.env.example`, preserves the comments from `.env.example` in your generated `.env`, prompts for the required settings, and can generate secure passwords and application secrets with `openssl rand`.

During setup you can choose the packaged Caddy reverse proxy, Nginx Proxy Manager, or another external reverse proxy path. You can also choose Docker named volumes or local `./data` subdirectories for persistent container data.

After the files are generated, the script lets you either stop with ready-to-use config files or continue into the guided start flow. The start flow prompts before pulling images and before running `docker compose up -d`, waits for the API to become healthy, then walks you through signing in with the one-time bootstrap credentials. Once you confirm first login is complete, it removes the bootstrap values from `.env`.

On Linux hosts with systemd, the guided setup can also install a reboot startup service for cleaner shutdowns and startups. On shutdown, it asks Docker Compose to stop the Breeze stack before Docker itself stops. On startup, it reruns Compose after Docker and networking are online, helping Breeze bring up Postgres/Redis, API/Web, and optional services in the intended order. The service stores its helper in a root-owned system path and points it at the setup directory you selected. For an existing guided install, run `./guided-setup.sh --install-systemd` from the Breeze setup directory.

### Option 3: Self-Hosted Manual Docker

Requires [Docker](https://docs.docker.com/get-docker/) and Docker Compose.

```bash
mkdir breeze && cd breeze
curl -fsSLO https://raw.githubusercontent.com/lanternops/breeze/main/docker-compose.yml
curl -fsSLO https://raw.githubusercontent.com/lanternops/breeze/main/.env.example
# Caddy config — the compose file bind-mounts this, so it must exist on disk first.
# (If it's missing, Docker creates docker/Caddyfile.prod as a directory and Caddy fails.)
curl -fsSL --create-dirs -o docker/Caddyfile.prod https://raw.githubusercontent.com/lanternops/breeze/main/docker/Caddyfile.prod
cp .env.example .env

# Edit .env — at minimum set these:
#   BREEZE_DOMAIN        your domain (or "localhost" for local testing)
#   ACME_EMAIL           email for Let's Encrypt certs
#   JWT_SECRET           openssl rand -base64 64
#   AGENT_ENROLLMENT_SECRET  openssl rand -hex 32
#   APP_ENCRYPTION_KEY   openssl rand -hex 32
#   MFA_ENCRYPTION_KEY   openssl rand -hex 32
#   ENROLLMENT_KEY_PEPPER    openssl rand -base64 32
#   MFA_RECOVERY_CODE_PEPPER openssl rand -base64 32
#   BREEZE_BOOTSTRAP_ADMIN_EMAIL     your admin email, first boot only
#   BREEZE_BOOTSTRAP_ADMIN_PASSWORD  one-time value from `openssl rand -base64 32`
#
# BREEZE_VERSION ships pinned to a known-good release. Bump it to upgrade
# (see https://github.com/lanternops/breeze/releases for the current version).

# Optional — for remote desktop (WebRTC TURN relay):
#   TURN_HOST            public IP of your TURN server
#   TURN_SECRET          openssl rand -hex 32

docker compose up -d

# To enable TURN for remote desktop across NATs/firewalls:
# docker compose --profile turn up -d
```

Breeze will be running at `https://your-domain` (or `https://localhost` with a self-signed cert for local testing).

On first production boot against an empty database, Breeze creates the initial Partner Admin only from operator-provided `BREEZE_BOOTSTRAP_ADMIN_EMAIL` and `BREEZE_BOOTSTRAP_ADMIN_PASSWORD` values. If those values are missing, startup refuses to seed the empty production database. The password is never printed to logs. After you sign in and finish setup, remove those bootstrap values from `.env`.

For hardened production deploys (Cloudflare Tunnel, mandatory digest-pinned images, monitoring + logging), see [docs/DEPLOY_PRODUCTION.md](docs/DEPLOY_PRODUCTION.md) which uses `deploy/docker-compose.prod.yml`.

### Install the Agent

From your Breeze dashboard, navigate to **Settings → Agents → Download** to get the agent installer for your platform.

Or install directly:

```bash
# Build from source
cd agent
make build

# Binaries land in agent/bin/ — including breeze-agent, breeze-desktop-helper,
# breeze-watchdog, and breeze-backup.
# See docs/AGENT_INSTALLATION.md for enrollment instructions.
```

### Enable the AI Brain (Optional)

1. Go to **Settings → AI Brain → BYOK**
2. Enter your [Anthropic API key](https://console.anthropic.com/)
3. The AI assistant is now active on every page

---

## AI Brain

Breeze ships with the Claude Agent SDK integrated and an MCP server you can point any AI agent at. The AI isn't a separate product or plugin — it's woven into the platform, and the same risk engine governs every action whether it comes from the in-product chat or from an external agent over MCP.

### How It Works

The AI brain has access to **tools** — the same capabilities you have in the dashboard. When you ask it to investigate an alert, it can query device details, check event logs, run diagnostic scripts, and propose remediations. When it decides to take an action, that action passes through the **risk engine** before execution.

```
You: "Why is ACME-WS05 running slow?"

Brain: I'll investigate. Let me check the device health.
       → [calls get_device_details]
       → [calls get_event_stream]
       → [calls run_script: Get-Process | Sort-Object CPU -Descending | Select -First 10]

       ACME-WS05 has high CPU from Windows Update stuck in a retry loop.
       KB5034441 failed with error 0x80070643 — the recovery partition
       is too small. I can fix this by extending the partition and
       retrying the update.

       ⚠️ This requires running a disk partition script (Risk: High).
       Approve? [Yes] [Modify] [Deny]
```

### Risk Classification

Every action the AI can take is classified by risk level. This is enforced by the RMM, not the AI — the brain cannot bypass it.

| Risk Level | Behavior | Examples |
|---|---|---|
| **Low** | Auto-execute, logged | Query devices, read logs, generate reports |
| **Medium** | Execute + notify tech | Run read-only scripts, deploy pre-approved patches |
| **High** | Requires human approval | State-changing scripts, patches outside maintenance window |
| **Critical** | Blocked entirely | Wipe device, bulk destructive operations |

Risk policies are fully configurable per partner, organization, site, or device group.

### BYOK vs LanternOps Brain

| Capability | BYOK (Free) | LanternOps Brain |
|---|---|---|
| AI chat on every page | ✅ | ✅ |
| Tool-equipped agent | ✅ | ✅ |
| Risk-classified actions | ✅ | ✅ |
| Persistent memory | ❌ | ✅ |
| Cross-tenant intelligence | ❌ | ✅ |
| Automated playbooks | ❌ | ✅ |
| Proactive remediation | ❌ | ✅ |
| Compliance evidence | ❌ | ✅ |
| Client-facing reports | ❌ | ✅ |
| Escalation routing | ❌ | ✅ |

---

## Architecture

### Multi-Tenant Hierarchy

```
Partner (MSP) → Organization (Customer) → Site (Location) → Device Group → Device
```

Every entity in Breeze is scoped to this hierarchy. Permissions, policies, alerts, and AI risk classifications cascade down and can be overridden at any level.

### Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Astro + React Islands |
| API | Hono (TypeScript) |
| Database | PostgreSQL with forced row-level security + Drizzle ORM |
| Queue | BullMQ + Redis |
| Agent | Go (cross-platform); native helper/viewer in Tauri (Rust) |
| Real-time | WebSocket + HTTP polling |
| Remote Access | WebRTC + coturn TURN relay |
| Reverse Proxy | Caddy with automatic Let's Encrypt |
| AI | Claude Agent SDK (Anthropic), MCP server with OAuth 2.1 |

### Brain Connector

The Brain Connector is the interface between the RMM and any AI brain (BYOK or LanternOps). It exposes RMM capabilities as Agent SDK tools and enforces risk classification on every action.

```
┌─────────────────────────────┐
│  AI Brain                   │
│  (BYOK local or LanternOps) │
│         │                   │
│    Agent SDK                │
│    "I need to check this    │
│     device's patch status"  │
│         │                   │
│    calls get_patch_status() │
└─────────┬───────────────────┘
          │
          ▼
┌─────────────────────────────┐
│  Brain Connector            │
│  ┌───────────────────────┐  │
│  │   Risk Validator      │  │
│  │   (always enforced)   │  │
│  └───────────────────────┘  │
│         │                   │
│    RMM Core                 │
│    (devices, agents, data)  │
└─────────────────────────────┘
```

For detailed architecture documentation, see [docs/architecture.md](docs/architecture.md).

---

## Roadmap

### Now
- [x] Device inventory (hardware, software, network, security)
- [x] Remote terminal, file browser, desktop, activity monitoring
- [x] Remote scripting
- [x] Patch management with maintenance windows + update rings
- [x] Health checks & alerting
- [x] Configuration policies (hierarchical with feature links)
- [x] Advanced filtering
- [x] AI chat with tool-equipped agent (BYOK)
- [x] Risk-classified action engine
- [x] Multi-tenant hierarchy
- [x] macOS, Windows, and Linux agents
- [x] Network discovery (ARP, ICMP, port, SNMP)
- [x] Endpoint backup (snapshot, bare-metal recovery, Hyper-V, SQL Server)
- [x] Cloud-to-cloud backup (M365)
- [x] EDR integrations (SentinelOne, Huntress)
- [x] MCP server with OAuth 2.1 for external AI agents
- [x] Native viewer + helper desktop apps (macOS, Windows)
- [x] Watchdog auto-restart and agent self-update
- [x] Reports & client-facing exports
- [x] CIS hardening checks and audit baselines
- [x] Email verification + cross-tenant abuse controls

### Next
- [ ] LanternOps Brain connector (managed AI brain with cross-tenant intelligence)
- [ ] Playbook engine (executable workflow runtime)
- [ ] Approval workflow UI for high-risk AI actions
- [ ] Expanded compliance framework evaluations
- [ ] PSA integrations (ConnectWise, Autotask, HaloPSA)
- [ ] Documentation platform integrations (IT Glue, Hudu)
- [ ] Mobile app (iOS / Android) — alerts, approvals, on-call response
- [ ] SSO (SAML, OIDC) — implemented, awaiting field validation

### Later
- [ ] Cross-tenant intelligence
- [ ] Proactive remediation
- [ ] Marketplace for community playbooks

---

## Platform Support

| Platform | Agent Status | Notes |
|---|---|---|
| macOS | ✅ Working | Primary development platform; native helper + viewer |
| Windows | ✅ Working | Full feature parity with macOS; signed MSI installer + Watchdog service |
| Linux | ✅ Working | Daemon + service install via systemd; remote desktop and discovery require root |

---

## Contributing

Breeze is built by MSPs, for MSPs. Contributions are welcome.

### Getting Started

```bash
# Clone the repo
git clone https://github.com/lanternops/breeze.git
cd breeze

# Install dependencies
pnpm install

# Apply database migrations
pnpm db:migrate

# Start the dev server (API + web + helper)
pnpm dev

# Build the Go agent
cd agent
make build  # outputs to agent/bin/
```

### Ways to Contribute

- **Bug reports** — Found something broken? [Open an issue](https://github.com/lanternops/breeze/issues).
- **Feature requests** — Have an idea? [Start a discussion](https://github.com/lanternops/breeze/discussions).
- **Code** — Pick up an issue, submit a PR. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.
- **Agent testing** — Run the agent on Windows/Linux and report what works and what doesn't.
- **Playbooks** — Share your remediation workflows so others can use them.
- **Documentation** — Help us make the docs better.

### Community

- [Discord](https://breezermm.com/discord) — Chat with the team and other MSPs
- [GitHub Discussions](https://github.com/lanternops/breeze/discussions) — Feature requests and ideas
- [Twitter/X](https://twitter.com/breeze_rmm) — Updates and announcements

---

## FAQ

**Is this really free?**
Yes. Breeze is AGPL-3.0 licensed. Self-host it, use it in production, manage as many endpoints as you want. Free forever.

**What's the catch?**
No catch. The business model is [LanternOps](https://lanternops.io) — a managed AI brain that connects to Breeze and adds persistent memory, cross-tenant intelligence, automated playbooks, and compliance evidence. Breeze is great on its own. LanternOps makes it autonomous.

**How is this different from Tactical RMM?**
Tactical RMM is a solid project. Breeze is AI-native — the agent SDK and tool system are core to the architecture, not an integration. We also have built-in remote access (WebRTC), a modern frontend (Astro + React), and a multi-tenant hierarchy designed for MSPs from day one.

**Can I use this for my internal IT team (not an MSP)?**
Absolutely. The multi-tenant hierarchy works for internal IT too — just use Organizations as departments or offices.

**What AI models are supported?**
For the in-product AI chat, Breeze uses the Claude Agent SDK (Anthropic). BYOK mode requires an Anthropic API key. We chose Claude for its tool-use capabilities and reasoning quality. Separately, Breeze runs a built-in MCP server with OAuth 2.1 + PKCE, so you can connect Claude.ai, ChatGPT, Cursor, or any other MCP-compatible AI agent — using whichever model that platform runs. We're open to community contributions for additional in-product model providers.

**Is there an agent auto-update?**
Yes. The Breeze agent has a built-in updater that pulls signed release artifacts and self-installs across macOS, Windows, and Linux. The Watchdog service supervises the agent process and restarts it on failure. Production deployments verify Ed25519-signed release manifests via `RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS`.

**Is my data safe?**
Self-hosted: your data never leaves your infrastructure. Cloud-hosted: data is isolated per partner with strict tenant separation. See our [Security Practices](docs/SECURITY_PRACTICES.md) for the full security whitepaper, including SOC 2 alignment mapping, encryption standards, and audit controls.

---

## License

Breeze is licensed under [AGPL-3.0](LICENSE).

You can use, modify, and self-host Breeze freely. If you modify Breeze and offer it as a service, you must open source your modifications under the same license.

---

<p align="center">
  Built by <a href="https://lanternops.io">LanternOps</a>
</p>
