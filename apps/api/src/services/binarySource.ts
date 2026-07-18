export type BinarySource = 'local' | 'github';

const GITHUB_RELEASE_BASE = 'https://github.com/bl4ckxr0sexd/bl4ck/releases';
const GITHUB_REPOSITORY = 'bl4ckxr0sexd/bl4ck';

let binarySourceWarned = false;

export function getBinarySource(): BinarySource {
  const raw = (process.env.BINARY_SOURCE || 'github').trim().toLowerCase();
  if (raw === 'local') return 'local';
  if (raw !== 'github' && !binarySourceWarned) {
    console.warn(`[binarySource] Unrecognized BINARY_SOURCE="${raw}", defaulting to "github"`);
    binarySourceWarned = true;
  }
  return 'github';
}

/**
 * Controls whether binarySync auto-promotes a newly-registered binary to the
 * fleet upgrade target (agent_versions.isLatest=true). Defaults TRUE so existing
 * self-host behavior is unchanged: publishing/syncing a release immediately
 * becomes the upgrade target. Set AGENT_AUTO_PROMOTE=false to decouple
 * registration from promotion — new binaries become downloadable but the fleet
 * upgrade target only changes via the explicit POST /agent-versions/promote
 * endpoint. See docs/superpowers/specs/2026-06-23-controlled-agent-fleet-rollout.md.
 */
export function getAgentAutoPromote(): boolean {
  const raw = process.env.AGENT_AUTO_PROMOTE?.trim().toLowerCase();
  if (raw === undefined || raw === '') return true; // default: preserve current behavior
  return !['false', '0', 'no', 'off'].includes(raw);
}

export function getGithubReleaseVersion(): string {
  return process.env.BINARY_VERSION || process.env.BREEZE_VERSION || 'latest';
}

export function getGithubReleasePageUrl(): string {
  const version = getGithubReleaseVersion();
  if (version === 'latest') {
    return `${GITHUB_RELEASE_BASE}/latest`;
  }
  return `${GITHUB_RELEASE_BASE}/tag/v${version}`;
}

function githubDownloadBase(): string {
  const version = getGithubReleaseVersion();
  if (version === 'latest') {
    return `${GITHUB_RELEASE_BASE}/latest/download`;
  }
  return `${GITHUB_RELEASE_BASE}/download/v${version}`;
}

export function getGithubReleaseRepository(): string {
  return process.env.BINARY_GITHUB_REPOSITORY?.trim() || GITHUB_REPOSITORY;
}

export function getGithubExpectedReleaseTag(): string | null {
  const version = getGithubReleaseVersion();
  if (version === 'latest') return null;
  return version.startsWith('v') ? version : `v${version}`;
}

export function getGithubReleaseArtifactManifestUrl(): string {
  return `${githubDownloadBase()}/release-artifact-manifest.json`;
}

export function getGithubReleaseArtifactManifestSignatureUrl(): string {
  return `${githubDownloadBase()}/release-artifact-manifest.json.ed25519`;
}

export function getGithubAgentUrl(os: string, arch: string): string {
  const extension = os === 'windows' ? '.exe' : '';
  const filename = `bl4ck-agent-${os}-${arch}${extension}`;
  return `${githubDownloadBase()}/${filename}`;
}

export function getGithubBackupUrl(os: string, arch: string): string {
  const extension = os === 'windows' ? '.exe' : '';
  const filename = `bl4ck-backup-${os}-${arch}${extension}`;
  return `${githubDownloadBase()}/${filename}`;
}

export function getGithubAgentPkgUrl(os: string, arch: string): string {
  const filename = `bl4ck-agent-${os}-${arch}.pkg`;
  return `${githubDownloadBase()}/${filename}`;
}

export function getGithubWatchdogUrl(os: string, arch: string): string {
  const extension = os === 'windows' ? '.exe' : '';
  const filename = `bl4ck-watchdog-${os}-${arch}${extension}`;
  return `${githubDownloadBase()}/${filename}`;
}

// breeze-user-helper is the GUI-subsystem sibling of bl4ck-agent. The agent
// only prefetches it on Windows today, but this mirrors the other per-(os,arch)
// asset URL helpers and stays OS-general. It is a distinct release asset from
// the Tauri "helper" app served by HELPER_FILENAMES — don't conflate the two
// (#1878).
export function getGithubUserHelperUrl(os: string, arch: string): string {
  const extension = os === 'windows' ? '.exe' : '';
  const filename = `bl4ck-user-helper-${os}-${arch}${extension}`;
  return `${githubDownloadBase()}/${filename}`;
}

export function getGithubRegularMsiUrl(): string {
  return `${githubDownloadBase()}/bl4ck-agent.msi`;
}

// The silent EXE installer (bl4ck-setup.exe) — embeds the MSI and enrolls by
// parsing the (TOKEN@HOST) group from its own download filename. Published as a
// release asset alongside the MSI.
export function getGithubSetupExeUrl(): string {
  return `${githubDownloadBase()}/bl4ck-setup.exe`;
}

export const VIEWER_FILENAMES: Record<string, string> = {
  macos: 'breeze-viewer-macos.dmg',
  windows: 'breeze-viewer-windows.msi',
  linux: 'breeze-viewer-linux.AppImage',
};

export function getGithubViewerUrl(platform: string): string {
  const filename = VIEWER_FILENAMES[platform];
  if (!filename) throw new Error(`Unknown viewer platform: ${platform}`);
  return `${githubDownloadBase()}/${filename}`;
}

export const HELPER_FILENAMES: Record<string, string> = {
  darwin: 'bl4ck-helper-macos.dmg',
  windows: 'bl4ck-helper-windows.msi',
  linux: 'bl4ck-helper-linux.AppImage',
};

export function getGithubHelperUrl(os: string): string {
  const filename = HELPER_FILENAMES[os];
  if (!filename) throw new Error(`Unknown helper OS: ${os}`);
  return `${githubDownloadBase()}/${filename}`;
}

/**
 * URL of the notarized BL4CK Installer.app.zip for the current release.
 * Asset is uploaded by the build-macos-installer-app job in release.yml.
 */
export function getGithubInstallerAppUrl(): string {
  // GitHub Releases auto-rewrites spaces in attached asset filenames to dots,
  // so the on-disk artifact "BL4CK Installer.app.zip" is served at this URL.
  return `${githubDownloadBase()}/BL4CK.Installer.app.zip`;
}
