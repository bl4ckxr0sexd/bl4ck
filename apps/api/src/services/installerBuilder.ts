import type { Context } from 'hono';
import archiver from 'archiver';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import {
  getBinarySource,
  getGithubExpectedReleaseTag,
  getGithubRegularMsiUrl,
  getGithubReleaseArtifactManifestSignatureUrl,
  getGithubReleaseArtifactManifestUrl,
  getGithubReleaseRepository,
} from './binarySource';
import { verifyGithubReleaseArtifactBuffer } from './releaseArtifactManifest';

// --- Enrollment key validation ---

const ENROLLMENT_KEY_PATTERN = /^[a-f0-9]{64}$/;

function assertValidEnrollmentKey(key: string): void {
  if (!ENROLLMENT_KEY_PATTERN.test(key)) {
    throw new Error('Invalid enrollment key: must be 64 lowercase hex chars');
  }
}

// --- Windows zip bundle builder (fallback when remote signing service is not configured) ---

function generateWindowsInstallScript(enrollmentKey: string): string {
  return `@echo off
setlocal EnableDelayedExpansion

REM This installer runs msiexec, which requires elevation. Run unelevated it
REM silently fails, the agent binary never lands in %ProgramFiles%\\BL4CK, and
REM the enroll step below then errors with a confusing "path not found" -- yet
REM the script used to still print "installed successfully" (#1832). Fail fast
REM with a clear message instead.
net session >nul 2>&1
if errorlevel 1 (
    echo Error: this installer must be run as Administrator.
    echo Right-click install.bat and choose "Run as administrator", or run it from an elevated command prompt.
    exit /b 1
)

set "SCRIPT_DIR=%~dp0"
set "ENROLLMENT_JSON=%SCRIPT_DIR%enrollment.json"
set "MSI_PATH=%SCRIPT_DIR%bl4ck-agent.msi"

if not exist "%ENROLLMENT_JSON%" (
    echo Error: enrollment.json not found
    exit /b 1
)

echo Installing BL4CK Agent...
msiexec /i "%MSI_PATH%" /quiet /norestart
REM msiexec: 0 = success, 3010 = success but reboot pending; anything else failed.
set "MSI_RC=!errorlevel!"
if not "!MSI_RC!"=="0" if not "!MSI_RC!"=="3010" (
    echo Error: agent installation failed ^(msiexec exit code !MSI_RC!^).
    exit /b 1
)

REM Wait for install to complete
timeout /t 5 /nobreak >nul

REM Read enrollment config and enroll
for /f "usebackq tokens=1,* delims=:" %%a in (\`type "%ENROLLMENT_JSON%"\`) do (
    set "key=%%~a"
    set "val=%%~b"
    set "key=!key: =!"
    set "key=!key:"=!"
    set "val=!val: =!"
    set "val=!val:"=!"
    set "val=!val:,=!"
    if "!key!"=="serverUrl" set "SERVER_URL=!val!"
    if "!key!"=="enrollmentSecret" set "ENROLLMENT_SECRET=!val!"
)

set ENROLLMENT_KEY="${enrollmentKey}"
set ENROLL_CMD="%ProgramFiles%\\BL4CK\\bl4ck-agent.exe" enroll "%ENROLLMENT_KEY%" --server "%SERVER_URL%"
if defined ENROLLMENT_SECRET if not "%ENROLLMENT_SECRET%"=="" (
    set ENROLL_CMD=%ENROLL_CMD% --enrollment-secret "%ENROLLMENT_SECRET%"
)

echo Enrolling agent...
%ENROLL_CMD%
set "ENROLL_RC=!errorlevel!"

REM Clean up credentials regardless of outcome (they must not be left behind).
del "%ENROLLMENT_JSON%" 2>nul

if not "!ENROLL_RC!"=="0" (
    echo Error: agent enrollment failed ^(exit code !ENROLL_RC!^).
    exit /b 1
)

echo BL4CK agent installed and enrolled successfully.
`;
}

interface WindowsZipValues {
  serverUrl: string;
  enrollmentKey: string;
  enrollmentSecret: string;
  siteId: string;
}

export async function buildWindowsInstallerZip(
  msiBuffer: Buffer,
  values: WindowsZipValues
): Promise<Buffer> {
  assertValidEnrollmentKey(values.enrollmentKey);
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 6 } });
    const chunks: Buffer[] = [];

    archive.on('data', (chunk: Buffer) => chunks.push(chunk));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);

    archive.append(msiBuffer, { name: 'bl4ck-agent.msi' });

    const enrollmentJson = JSON.stringify(
      {
        serverUrl: values.serverUrl,
        enrollmentKey: values.enrollmentKey,
        enrollmentSecret: values.enrollmentSecret,
        siteId: values.siteId,
      },
      null,
      2
    );
    archive.append(enrollmentJson, { name: 'enrollment.json' });
    const installScript = generateWindowsInstallScript(values.enrollmentKey);
    archive.append(installScript, { name: 'install.bat' });

    archive.finalize().catch(reject);
  });
}

// --- Binary fetch helpers (moved from enrollmentKeys.ts) ---

export async function fetchRegularMsi(): Promise<Buffer> {
  if (getBinarySource() === 'github') {
    const url = getGithubRegularMsiUrl();
    const resp = await fetch(url, { redirect: 'follow' });
    if (!resp.ok) throw new Error(`Failed to fetch regular MSI: ${resp.status}`);
    const buffer = Buffer.from(await resp.arrayBuffer());
    await verifyGithubReleaseArtifactBuffer({
      assetName: 'bl4ck-agent.msi',
      assetBuffer: buffer,
      manifestUrl: getGithubReleaseArtifactManifestUrl(),
      signatureUrl: getGithubReleaseArtifactManifestSignatureUrl(),
      expectedRepository: getGithubReleaseRepository(),
      expectedRelease: getGithubExpectedReleaseTag(),
      expectedPlatformTrust: 'windows-authenticode-required',
    });
    return buffer;
  }
  const binaryDir = resolve(process.env.AGENT_BINARY_DIR || './agent/bin');
  return readFile(join(binaryDir, 'bl4ck-agent.msi'));
}

/**
 * Serves the static, CI-signed MSI with the bootstrap token embedded in the
 * download filename — the Windows analogue of the macOS renamed-app zip. The
 * MSI bytes are never modified, so the Authenticode signature stays intact and
 * every customer shares one file hash (SmartScreen reputation accrues).
 *
 * The token is wrapped in PARENTHESES, not square brackets. At install time the
 * download path travels through MSI's Formatted-field engine (OriginalDatabase
 * -> SetBootstrapData -> CustomActionData), and a "[...]" substring (brackets
 * are that engine's property-reference delimiter) gets stripped along the way,
 * silently dropping the token — agents then log "no bootstrap token present"
 * and never enroll (observed in #1956). Parens are not special in MSI Formatted
 * fields, so they survive. The agent parser (installer_filename.go) accepts
 * both forms; the macOS download carries the token in bootstrap.json instead.
 */
export function serveWindowsBootstrapMsi(
  c: Context,
  args: { msi: Buffer; token: string; apiHost: string },
): Response {
  const filename = `Bl4ck Agent (${args.token}@${args.apiHost}).msi`;
  c.header('Content-Type', 'application/octet-stream');
  c.header('Content-Disposition', `attachment; filename="${filename}"`);
  c.header('Content-Length', String(args.msi.length));
  c.header('Cache-Control', 'no-store');
  return c.body(args.msi as unknown as ArrayBuffer);
}
