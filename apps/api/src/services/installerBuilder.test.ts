import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import JSZip from 'jszip';
import {
  buildWindowsInstallerZip,
  fetchRegularMsi,
  fetchSetupExe,
  serveWindowsBootstrapMsi,
  serveWindowsBootstrapExe,
} from './installerBuilder';
import type { Context } from 'hono';

// Real keys are 64 lowercase hex chars produced by randomBytes(32).toString('hex').
// Tests use that exact generator so a future drift between generator and validator
// fails here loudly.
function realEnrollmentKey(): string {
  return randomBytes(32).toString('hex');
}

function signedReleaseManifest(assetName: string, assetBuffer: Buffer) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicDer = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const rawPublicKey = publicDer.subarray(publicDer.length - 32).toString('base64');
  const manifest = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    repository: 'bl4ckxr0sexd/bl4ck',
    release: 'v1.2.3',
    assets: [
      {
        name: assetName,
        sha256: createHash('sha256').update(assetBuffer).digest('hex'),
        size: assetBuffer.length,
        platformTrust: 'windows-authenticode-required',
      },
    ],
  }));

  return {
    manifest,
    signature: Buffer.from(sign(null, manifest, privateKey).toString('base64')),
    publicKey: rawPublicKey,
  };
}

describe('fetchRegularMsi', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  it('verifies GitHub release MSI bytes against the signed release artifact manifest', async () => {
    const asset = Buffer.from('signed-msi');
    const signed = signedReleaseManifest('bl4ck-agent.msi', asset);
    process.env.BINARY_SOURCE = 'github';
    process.env.BINARY_VERSION = '1.2.3';
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;

    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/bl4ck-agent.msi')) return new Response(asset);
      if (url.endsWith('/release-artifact-manifest.json')) return new Response(signed.manifest);
      if (url.endsWith('/release-artifact-manifest.json.ed25519')) return new Response(signed.signature);
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchRegularMsi()).resolves.toEqual(asset);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://github.com/bl4ckxr0sexd/bl4ck/releases/download/v1.2.3/release-artifact-manifest.json.ed25519',
      { redirect: 'follow' },
    );
  });
});

describe('buildWindowsInstallerZip', () => {
  it('rejects an enrollment key with shell-meaningful characters', async () => {
    await expect(
      buildWindowsInstallerZip(Buffer.from('msi'), {
        serverUrl: 'https://breeze.example.com',
        enrollmentKey: 'abc\nrm -rf /',
        enrollmentSecret: 'secret456',
        siteId: '550e8400-e29b-41d4-a716-446655440000',
      })
    ).rejects.toThrow(/invalid enrollment key/i);
  });

  it('rejects an enrollment key with the legacy brz_ prefix (drift guard)', async () => {
    await expect(
      buildWindowsInstallerZip(Buffer.from('msi'), {
        serverUrl: 'https://breeze.example.com',
        enrollmentKey: 'brz_' + realEnrollmentKey(),
        enrollmentSecret: 'secret456',
        siteId: '550e8400-e29b-41d4-a716-446655440000',
      })
    ).rejects.toThrow(/invalid enrollment key/i);
  });

  it('quotes ENROLLMENT_KEY in install.bat', async () => {
    const validKey = realEnrollmentKey();
    const zip = await buildWindowsInstallerZip(Buffer.from('msi'), {
      serverUrl: 'https://breeze.example.com',
      enrollmentKey: validKey,
      enrollmentSecret: 'secret456',
      siteId: '550e8400-e29b-41d4-a716-446655440000',
    });

    const zipInstance = await JSZip.loadAsync(zip);
    const batScript = await zipInstance.files['install.bat']!.async('string');
    expect(batScript).toContain(`set ENROLLMENT_KEY="${validKey}"`);
  });

  it('gates install.bat on elevation before running msiexec (#1832)', async () => {
    const zip = await buildWindowsInstallerZip(Buffer.from('msi'), {
      serverUrl: 'https://breeze.example.com',
      enrollmentKey: realEnrollmentKey(),
      enrollmentSecret: 'secret456',
      siteId: '550e8400-e29b-41d4-a716-446655440000',
    });
    const zipInstance = await JSZip.loadAsync(zip);
    const batScript = await zipInstance.files['install.bat']!.async('string');

    // Admin gate exists and runs before the msiexec install line.
    expect(batScript).toContain('net session >nul 2>&1');
    expect(batScript).toMatch(/must be run as Administrator/i);
    expect(batScript.indexOf('net session')).toBeLessThan(batScript.indexOf('msiexec /i'));

    // Success is no longer printed unconditionally: it must come after the
    // enroll exit-code guard, and msiexec failures abort the run.
    expect(batScript).toContain('set "MSI_RC=!errorlevel!"');
    expect(batScript).toContain('set "ENROLL_RC=!errorlevel!"');
    const guardIdx = batScript.indexOf('if not "!ENROLL_RC!"=="0"');
    const successIdx = batScript.indexOf('installed and enrolled successfully');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(successIdx);
  });
});

describe('serveWindowsBootstrapMsi', () => {
  // Minimal Hono Context stub capturing headers + body. Both Windows download
  // routes (enrollmentKeys.ts) delegate here, so this is the single source of
  // truth for the download filename.
  function fakeContext(): { c: Context; headers: Map<string, string>; body: Buffer | null } {
    const headers = new Map<string, string>();
    const state: { body: Buffer | null } = { body: null };
    const c = {
      header: (k: string, v: string) => headers.set(k.toLowerCase(), v),
      body: (b: Buffer) => {
        state.body = b;
        return new Response();
      },
    } as unknown as Context;
    return { c, headers, body: state.body };
  }

  it('wraps the bootstrap token in PARENTHESES, never square brackets', () => {
    const { c, headers } = fakeContext();
    serveWindowsBootstrapMsi(c, {
      msi: Buffer.from('signed-msi-bytes'),
      token: 'ABCDE12345',
      apiHost: 'api.example.com',
    });

    const cd = headers.get('content-disposition');
    expect(cd).toBe(
      'attachment; filename="Bl4ck Agent (ABCDE12345@api.example.com).msi"',
    );
    // Regression guard for #1956: a square-bracket [TOKEN@HOST] delimiter is
    // eaten by MSI's Formatted-field engine, dropping the token so agents never
    // enroll. If someone reverts the delimiter, this fails — the route-level
    // tests can't catch it because they mock this function.
    expect(cd).not.toContain('[');
    expect(cd).not.toContain(']');
  });

  it('serves the MSI bytes unmodified with octet-stream + no-store headers', () => {
    const { c, headers } = fakeContext();
    const msi = Buffer.from('signed-msi-bytes');
    serveWindowsBootstrapMsi(c, { msi, token: 'ZZZZZ99999', apiHost: 'eu.2breeze.app' });

    expect(headers.get('content-type')).toBe('application/octet-stream');
    expect(headers.get('content-length')).toBe(String(msi.length));
    expect(headers.get('cache-control')).toBe('no-store');
  });
});

describe('serveWindowsBootstrapExe', () => {
  function fakeContext(): { c: Context; headers: Map<string, string> } {
    const headers = new Map<string, string>();
    const c = {
      header: (k: string, v: string) => headers.set(k.toLowerCase(), v),
      body: () => new Response(),
    } as unknown as Context;
    return { c, headers };
  }

  it('embeds the bootstrap token in the .exe filename using PARENTHESES', () => {
    const { c, headers } = fakeContext();
    serveWindowsBootstrapExe(c, {
      exe: Buffer.from('signed-exe-bytes'),
      token: 'ABCDE12345',
      apiHost: 'api.example.com',
    });

    const cd = headers.get('content-disposition');
    // bl4ck-setup.exe parses (TOKEN@HOST) from its own filename — same parens,
    // not-brackets rule as the MSI (#1956).
    expect(cd).toBe(
      'attachment; filename="Bl4ck Setup (ABCDE12345@api.example.com).exe"',
    );
    expect(cd).not.toContain('[');
    expect(cd).not.toContain(']');
  });

  it('serves the EXE bytes unmodified with octet-stream + no-store headers', () => {
    const { c, headers } = fakeContext();
    const exe = Buffer.from('signed-exe-bytes');
    serveWindowsBootstrapExe(c, { exe, token: 'ZZZZZ99999', apiHost: 'eu.2breeze.app' });

    expect(headers.get('content-type')).toBe('application/octet-stream');
    expect(headers.get('content-length')).toBe(String(exe.length));
    expect(headers.get('cache-control')).toBe('no-store');
  });
});

describe('fetchSetupExe', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  it('verifies the GitHub setup EXE bytes against the signed release manifest', async () => {
    const asset = Buffer.from('signed-setup-exe');
    const signed = signedReleaseManifest('bl4ck-setup.exe', asset);
    process.env.BINARY_SOURCE = 'github';
    process.env.BINARY_VERSION = '1.2.3';
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;

    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/bl4ck-setup.exe')) return new Response(asset);
      if (url.endsWith('/release-artifact-manifest.json')) return new Response(signed.manifest);
      if (url.endsWith('/release-artifact-manifest.json.ed25519')) return new Response(signed.signature);
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchSetupExe()).resolves.toEqual(asset);
  });
});
