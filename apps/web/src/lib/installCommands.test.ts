import { describe, expect, it } from 'vitest';
import { buildInstallCommands } from './installCommands';

const base = {
  apiUrl: 'https://rmm.example.com',
  ghBase: 'https://github.com/lanternops/breeze/releases/latest/download',
  token: 'enroll_abc123',
};

describe('buildInstallCommands', () => {
  describe('Windows (PowerShell)', () => {
    it('stops on download failure via $ErrorActionPreference', () => {
      const { windows } = buildInstallCommands(base);
      expect(windows.startsWith("$ErrorActionPreference='Stop';")).toBe(true);
      expect(windows).toContain('Invoke-WebRequest');
      expect(windows).toContain('bl4ck-agent-windows-amd64.exe');
    });

    it('checks $LASTEXITCODE after every agent invocation', () => {
      const { windows } = buildInstallCommands(base);
      // Native exe failures do not throw in PowerShell — each of the three
      // agent steps (service install, enroll, service start) needs a check.
      expect(windows.match(/if\(\$LASTEXITCODE\)\{throw/g)).toHaveLength(3);
      expect(windows).toContain('enroll "enroll_abc123" --server "https://rmm.example.com"');
    });

    it('verifies the download is a real PE executable before running it', () => {
      const { windows } = buildInstallCommands(base);
      // The Windows analog of the unix shebang check: a captive portal's 200
      // HTML saved as bl4ck-agent.exe must be blamed on the network, not
      // surface as PowerShell's raw "not a valid application" exception.
      expect(windows).toContain('0x4D');
      expect(windows).toContain('0x5A');
      expect(windows).toContain('captive portal or web filter');
      // The MZ check must run before the first agent invocation.
      expect(windows.indexOf('0x4D')).toBeLessThan(windows.indexOf('service install'));
    });

    it('appends --enrollment-secret only when a secret is provided', () => {
      const withSecret = buildInstallCommands({ ...base, enrollmentSecret: 's3cret' });
      expect(withSecret.windows).toContain('--enrollment-secret "s3cret"');
      expect(buildInstallCommands(base).windows).not.toContain('--enrollment-secret');
    });
  });

  it('strips trailing slashes from apiUrl and ghBase', () => {
    const cmds = buildInstallCommands({
      ...base,
      apiUrl: 'https://rmm.example.com/',
      ghBase: 'https://gh.example.com/dl/',
    });
    expect(cmds.windows).not.toContain('com//');
    expect(cmds.windows).toContain('https://gh.example.com/dl/bl4ck-agent-windows-amd64.exe');
  });
});
