# BL4CK — Running TODO / Roadmap

Living checklist for the rebrand + self-host effort. Kept side-by-side with the
work so nothing is lost. **End goal:** a one-shot script that stands up BL4CK on a
fresh VPS in 2-3 commands (see the bottom section — that is the final deliverable).

Legend: [x] done · [~] in progress / partial · [ ] not started

---

## ✅ Done (merged to `main` via PR #28)
- [x] Web dashboard rebranded to BL4CK (logo, copy, PDF reports)
- [x] Agent + installer + services rebranded (`bl4ck-agent.exe`, `Bl4ckAgent`
      service, `C:\Program Files\BL4CK`, MSI identity, macOS/Linux packaging)
- [x] Silent EXE installer `bl4ck-setup.exe` (embeds MSI, `msiexec /qn`) + Make target
- [x] Wire-protocol header fix — `X-Breeze-*` kept unrenamed (server contract)
- [x] API release-artifact names aligned to `bl4ck-*` + GitHub base repointed to
      `github.com/bl4ckxr0sexd/bl4ck`
- [x] Docs: `BUILD-EXE-INSTALLER.md`, `DEPLOY-VPS.md`, `CHANGELOG.md`

## ✅ Done (on branch `installer-silent-quietexec`, NOT yet on main)
- [x] Helper IPC alignment — pipe/socket/config paths → `bl4ck` (commit `2fec3afb`)
  - [ ] **Open a PR + merge this to `main`** ← next housekeeping step

---

## 🔜 TODO — before first real deployment
- [ ] **Run the API test suite** — `pnpm install && pnpm test --filter=@breeze/api`
      (couldn't run here — no node_modules). Confirms the artifact-name rename didn't
      break anything.
- [ ] **Build the Helper once** with `cargo`/Tauri to compile-verify the IPC path
      changes (couldn't build here). Only needed if shipping the Helper app.
- [ ] **Decide the agent-binary delivery model** (this drives the installer script —
      see the big note below). `BINARY_SOURCE=local` vs `github`.
- [ ] **macOS release jobs**: either add the 7 `APPLE_*` secrets or disable the
      macOS jobs in `release.yml` so a Windows-only release doesn't fail.

## 🔐 TODO — code signing (cert arriving ~2-3 business days)
- [ ] Add Azure Trusted Signing secrets to the GitHub repo:
      `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SIGNING_ACCOUNT_NAME`,
      `AZURE_SIGNING_ENDPOINT`, `AZURE_CERT_PROFILE_PROD`, `AZURE_CERT_PROFILE_PRERELEASE`
- [ ] Add a signing step for `bl4ck-setup.exe` in `release.yml` (after MSI sign, so
      the EXE wraps the SIGNED MSI) — currently only the MSI + agent bins are signed
- [ ] When ready: **tell me "sign the exe and msi"** → I wire the signing steps
- [ ] Sign order matters: agent bins → MSI → EXE (outer sig must cover signed inner)

## 🖥️ TODO — web panel EXE option (best AFTER signing)
15 touch points across release → API → web. Summary:
- [ ] `release.yml`: build + sign `bl4ck-setup.exe`, add to verify list, upload,
      `cp` into `release-assets/`
- [ ] API `binarySource.ts`: `getGithubSetupExeUrl()`
- [ ] API `installerBuilder.ts`: `fetchSetupExe()` + `serveWindowsBootstrapExe()`
      emitting `Bl4ck Agent (TOKEN@HOST).exe` (keep the parens)
- [ ] API `enrollmentKeys.ts`: widen `platform` checks (2 routes) + `installerLinkSchema`
- [ ] web `AddDeviceModal.tsx` + `EnrollDeviceStep.tsx`: add `.exe` option;
      `downloadFilename.ts` fallback
  (Full list: `CHANGELOG.md` Phase 3 scoping + the 15-row table in chat history.)

## 🧹 TODO — housekeeping / nice-to-have
- [ ] Remove stray committed build artifact: `git rm --cached agent/breeze-backup`
      (61 MB macOS binary, unreferenced)
- [ ] Real BL4CK logo asset to replace the placeholder "B" monogram (favicon +
      2 inline SVGs + PDF `drawBrandMark`)
- [ ] REVOKE the personal access token pasted in chat earlier (security)
- [ ] Decide: keep the invisible internals as-is (Go module `breeze-rmm/agent`,
      `BREEZE_*` env vars, `breeze_app` DB role) — currently intentionally NOT renamed

---

## 🎯 FINAL DELIVERABLE — fresh-VPS installer script (2-3 cmds)

> User will say "create the installer script" when everything above is settled.
> Capturing the design + open decisions now so it can be built fast then.

**Target UX:**
```bash
curl -fsSL https://<host>/install.sh | bash -s -- --domain rmm.example.com
# or
git clone https://github.com/bl4ckxr0sexd/bl4ck && cd bl4ck && ./deploy/install.sh
```

**What the script must do** (draft):
1. Install prereqs (docker, docker-compose-plugin, git)
2. Clone/pull the repo to `/opt/bl4ck`
3. Generate `.env` — every secret via `openssl rand` (template already in
   `DEPLOY-VPS.md` §3)
4. Build from source (`docker-compose.override.yml.local-build`) — avoids the
   `ghcr.io/lanternops/*` images
5. Stage the Windows agent installers into `AGENT_BINARY_DIR`
6. Bring the stack up, wait for `/health`, print the admin password + next steps

### ✅ DECISION: Option A — `BINARY_SOURCE=github` (chosen)
User builds + signs the installers, publishes them to a GitHub release on
`bl4ckxr0sexd/bl4ck`, and the API fetches + verifies them from there. The
fresh-VPS script never builds a Windows installer — it just points the API at the
release. (Windows MSI/EXE can't be built on a Linux VPS anyway — WiX/go-winres are
Windows-only.)

**Non-obvious requirement — the signed manifest:** in `github` mode
`verifyGithubReleaseArtifactBuffer` checks every artifact against a signed
`release-artifact-manifest.json` (+ `.ed25519`), and the API refuses to boot in
production without `RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS`. So signed binaries
ALONE are not enough — the release must also carry the signed manifest, and the
VPS must trust its key. `release.yml` generates the manifest automatically, so the
reliable path is **tag → CI builds+signs+manifests+publishes**, not manual upload.

### Option A runbook (do once the cert lands)
1. [ ] Generate your OWN manifest keypairs (never reuse lanternops'):
       Ed25519 (`RELEASE_MANIFEST_ED25519_PRIVATE_KEY`/`_PUBLIC_KEY`) + minisign
       (`RELEASE_MANIFEST_MINISIGN_PRIVATE_KEY`/`_PUBLIC_KEY`). Commands in
       `DEPLOY-VPS.md` §7.
2. [ ] Add repo secrets: the 4 manifest keys + the 6 Azure signing secrets
       (+ Apple secrets, or disable the macOS jobs).
3. [ ] Add a **build+sign step for `bl4ck-setup.exe`** in `release.yml` (only the
       MSI/agent bins are signed today) — needed if the EXE is a release asset.
       This overlaps the "web panel EXE option" work above.
4. [ ] Push a version tag → CI builds, signs, generates the signed manifest, and
       publishes all `bl4ck-*` assets to the release.
5. [ ] Put the manifest **public** SPKI base64 into the VPS `.env` as
       `RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS`.
6. [ ] VPS `.env`: `BINARY_SOURCE=github` (repo default is already
       `bl4ckxr0sexd/bl4ck`; override via `BINARY_GITHUB_REPOSITORY` if needed).
7. [ ] Verify: dashboard → Add Device → Download Installer returns the signed MSI.

> The 2-3-cmd VPS script then just: install docker → clone → `.env` (with the
> manifest public key) → build API/web from source → up. No Windows build on the VPS.

### Other open decisions for the script
- [ ] Domain handling: flag/arg vs interactive prompt
- [ ] Email provider: leave blank (invites disabled) vs prompt for Resend key
- [ ] Where `install.sh` is hosted for the `curl | bash` form
- [ ] TLS: Caddy auto (needs public DNS) vs self-signed for IP-only test boxes
- [ ] Release tag pinning: API `latest` vs a pinned `BREEZE_VERSION` tag
