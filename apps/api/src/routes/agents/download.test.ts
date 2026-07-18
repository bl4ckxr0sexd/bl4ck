import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/s3Storage', () => ({
  isS3Configured: vi.fn(() => false),
  getPresignedUrl: vi.fn(),
  isS3NotFound: (err: unknown) => {
    const name = (err as { name?: string }).name;
    return name === 'NotFound' || name === 'NoSuchKey';
  },
}));

vi.mock('../../services/binarySource', () => ({
  getBinarySource: vi.fn(() => 'local'),
  getGithubAgentUrl: vi.fn(),
  getGithubHelperUrl: vi.fn(),
  getGithubUserHelperUrl: vi.fn(),
  getGithubWatchdogUrl: vi.fn(),
  HELPER_FILENAMES: {
    linux: 'bl4ck-desktop-helper-linux-amd64',
    darwin: 'bl4ck-desktop-helper-darwin',
    windows: 'bl4ck-desktop-helper-windows.exe',
  },
}));

import { downloadRoutes } from './download';
import { getBinarySource, getGithubUserHelperUrl, getGithubWatchdogUrl } from '../../services/binarySource';
import { isS3Configured, getPresignedUrl } from '../../services/s3Storage';

describe('public agent binary downloads', () => {
  const originalAgentDir = process.env.AGENT_BINARY_DIR;
  const originalHelperDir = process.env.HELPER_BINARY_DIR;

  beforeEach(() => {
    process.env.AGENT_BINARY_DIR = '/tmp/breeze-secret-agent-binaries';
    process.env.HELPER_BINARY_DIR = '/tmp/breeze-secret-helper-binaries';
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    if (originalAgentDir === undefined) delete process.env.AGENT_BINARY_DIR;
    else process.env.AGENT_BINARY_DIR = originalAgentDir;
    if (originalHelperDir === undefined) delete process.env.HELPER_BINARY_DIR;
    else process.env.HELPER_BINARY_DIR = originalHelperDir;
    vi.restoreAllMocks();
  });

  it('does not disclose AGENT_BINARY_DIR in public 404 responses', async () => {
    const res = await downloadRoutes.request('/download/linux/amd64');
    const body = await res.text();

    expect(res.status).toBe(404);
    expect(body).not.toContain('/tmp/breeze-secret-agent-binaries');
    expect(body).not.toContain('AGENT_BINARY_DIR');
    expect(console.warn).toHaveBeenCalledWith(
      '[agent-download] Local binary missing',
      { filename: 'bl4ck-agent-linux-amd64' },
    );
  });

  it('does not disclose HELPER_BINARY_DIR in public 404 responses', async () => {
    const res = await downloadRoutes.request('/download/helper/linux/amd64');
    const body = await res.text();

    expect(res.status).toBe(404);
    expect(body).not.toContain('/tmp/breeze-secret-helper-binaries');
    expect(body).not.toContain('HELPER_BINARY_DIR');
    expect(console.warn).toHaveBeenCalledWith(
      '[helper-download] Local binary missing',
      { filename: 'bl4ck-desktop-helper-linux-amd64' },
    );
  });

  it('does not disclose AGENT_BINARY_DIR in public watchdog 404 responses', async () => {
    // The watchdog binary is served from the same dir as the agent. The route
    // must exist (404, not 404-route-not-found) and not leak the path.
    const res = await downloadRoutes.request('/download/watchdog/linux/amd64');
    const body = await res.text();

    expect(res.status).toBe(404);
    expect(body).not.toContain('/tmp/breeze-secret-agent-binaries');
    expect(console.warn).toHaveBeenCalledWith(
      '[watchdog-download] Local binary missing',
      { filename: 'bl4ck-watchdog-linux-amd64' },
    );
  });

  it('redirects watchdog downloads to GitHub in github mode (per-arch, .exe on windows)', async () => {
    vi.mocked(getBinarySource).mockReturnValue('github');
    vi.mocked(getGithubWatchdogUrl).mockImplementation(
      (os: string, arch: string) =>
        `https://github.test/${os}-${arch}/bl4ck-watchdog`,
    );

    try {
      const lin = await downloadRoutes.request('/download/watchdog/linux/amd64');
      expect(lin.status).toBe(302);
      expect(lin.headers.get('location')).toBe('https://github.test/linux-amd64/bl4ck-watchdog');
      expect(getGithubWatchdogUrl).toHaveBeenCalledWith('linux', 'amd64');

      const win = await downloadRoutes.request('/download/watchdog/windows/amd64');
      expect(win.status).toBe(302);
      expect(getGithubWatchdogUrl).toHaveBeenCalledWith('windows', 'amd64');
    } finally {
      // Restore the module-mock default so later tests still see 'local'
      // (vi.restoreAllMocks does not reset vi.mock factory fns).
      vi.mocked(getBinarySource).mockReturnValue('local');
    }
  });

  it('rejects invalid OS/arch on the watchdog route', async () => {
    const badOs = await downloadRoutes.request('/download/watchdog/solaris/amd64');
    expect(badOs.status).toBe(400);
    const badArch = await downloadRoutes.request('/download/watchdog/linux/sparc');
    expect(badArch.status).toBe(400);
  });

  // #1878: user-helper (bl4ck-user-helper.exe) is a distinct Go binary from the
  // Tauri "helper" app, and its server-relative route must exist so the agent's
  // verified updater is not handed a github.com URL its host check rejects.
  it('does not disclose AGENT_BINARY_DIR in public user-helper 404 responses', async () => {
    const res = await downloadRoutes.request('/download/user-helper/windows/amd64');
    const body = await res.text();

    expect(res.status).toBe(404);
    expect(body).not.toContain('/tmp/breeze-secret-agent-binaries');
    expect(console.warn).toHaveBeenCalledWith(
      '[user-helper-download] Local binary missing',
      { filename: 'bl4ck-user-helper-windows-amd64.exe' },
    );
  });

  it('redirects user-helper downloads to GitHub in github mode (per-arch, .exe on windows)', async () => {
    vi.mocked(getBinarySource).mockReturnValue('github');
    vi.mocked(getGithubUserHelperUrl).mockImplementation(
      (os: string, arch: string) =>
        `https://github.test/${os}-${arch}/bl4ck-user-helper`,
    );

    try {
      const win = await downloadRoutes.request('/download/user-helper/windows/amd64');
      expect(win.status).toBe(302);
      expect(win.headers.get('location')).toBe('https://github.test/windows-amd64/bl4ck-user-helper');
      expect(getGithubUserHelperUrl).toHaveBeenCalledWith('windows', 'amd64');
    } finally {
      vi.mocked(getBinarySource).mockReturnValue('local');
    }
  });

  it('rejects invalid OS/arch on the user-helper route', async () => {
    const badOs = await downloadRoutes.request('/download/user-helper/solaris/amd64');
    expect(badOs.status).toBe(400);
    const badArch = await downloadRoutes.request('/download/user-helper/windows/sparc');
    expect(badArch.status).toBe(400);
  });

});

describe('S3 transport failures surface as 500, not a masked 404 (issue #1802)', () => {
  const originalAgentDir = process.env.AGENT_BINARY_DIR;
  const originalHelperDir = process.env.HELPER_BINARY_DIR;

  beforeEach(() => {
    // Point at non-existent dirs so any disk fallback would 404 — proving the
    // 500 comes from the S3 guard, not from a disk hit.
    process.env.AGENT_BINARY_DIR = '/tmp/breeze-nonexistent-agent-binaries';
    process.env.HELPER_BINARY_DIR = '/tmp/breeze-nonexistent-helper-binaries';
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(getBinarySource).mockReturnValue('local');
    vi.mocked(isS3Configured).mockReturnValue(true);
    vi.mocked(getPresignedUrl).mockRejectedValue(
      Object.assign(new Error('credentials expired'), { name: 'CredentialsProviderError' }),
    );
  });

  afterEach(() => {
    if (originalAgentDir === undefined) delete process.env.AGENT_BINARY_DIR;
    else process.env.AGENT_BINARY_DIR = originalAgentDir;
    if (originalHelperDir === undefined) delete process.env.HELPER_BINARY_DIR;
    else process.env.HELPER_BINARY_DIR = originalHelperDir;
    vi.restoreAllMocks();
    vi.mocked(getBinarySource).mockReset();
    vi.mocked(isS3Configured).mockReset();
    vi.mocked(getPresignedUrl).mockReset();
  });

  it.each([
    ['agent', '/download/linux/amd64', '[agent-download]'],
    ['helper', '/download/helper/linux/amd64', '[helper-download]'],
    ['watchdog', '/download/watchdog/linux/amd64', '[watchdog-download]'],
    ['user-helper', '/download/user-helper/windows/amd64', '[user-helper-download]'],
  ])('returns 500 for the %s route on a non-NotFound S3 error', async (_name, path, logTag) => {
    const res = await downloadRoutes.request(path);
    const body = await res.text();

    expect(res.status).toBe(500);
    expect(body).not.toContain('not available');
    expect(body).not.toContain('/tmp');
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(`${logTag} S3 presign failed`),
      expect.anything(),
    );
  });

  it.each([
    ['agent', '/download/linux/amd64', '[agent-download]', 'NotFound'],
    ['helper', '/download/helper/linux/amd64', '[helper-download]', 'NoSuchKey'],
    ['watchdog', '/download/watchdog/linux/amd64', '[watchdog-download]', 'NotFound'],
    ['user-helper', '/download/user-helper/windows/amd64', '[user-helper-download]', 'NotFound'],
  ])(
    'still falls back to disk and 404s for the %s route when the S3 object genuinely does not exist',
    async (_name, path, logTag, errName) => {
      vi.mocked(getPresignedUrl).mockRejectedValue(
        Object.assign(new Error('missing'), { name: errName }),
      );
      const res = await downloadRoutes.request(path);

      expect(res.status).toBe(404);
      // The genuine miss must be a warn-level fall-through, never the 500 error path.
      expect(console.error).not.toHaveBeenCalled();
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining(`${logTag} S3 object missing`),
        expect.anything(),
      );
    },
  );

  it('treats an S3 error with no identifiable name as a transport fault (500), not a missing object', async () => {
    // The whole fix hinges on the conservative default: anything we cannot
    // positively classify as NotFound/NoSuchKey must surface as a 500, never be
    // swallowed by the disk fallback. A future refactor that defaulted unknown
    // errors to "not found" would silently reintroduce the #1802 masking bug —
    // this pins the boundary. A bare Error has name 'Error' (not NotFound).
    vi.mocked(getPresignedUrl).mockRejectedValue(new Error('opaque failure'));
    const res = await downloadRoutes.request('/download/linux/amd64');

    expect(res.status).toBe(500);
    expect(console.error).toHaveBeenCalled();
  });
});
