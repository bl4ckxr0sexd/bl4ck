export interface InstallCommandOptions {
  /** BL4CK API origin, e.g. https://eu.2breeze.app */
  apiUrl: string;
  /** Base URL for direct Windows binary downloads (GitHub releases) */
  ghBase: string;
  /** Enrollment token from the Add Device / setup flow */
  token: string;
  /** Optional org enrollment secret */
  enrollmentSecret?: string;
}

export interface InstallCommands {
  windows: string;
}

/**
 * Builds the copy-paste agent install command shown in the Add Device modal
 * and the setup wizard.
 *
 * The MZ-magic check guards the Windows download: a captive portal's 200 HTML
 * saved as bl4ck-agent.exe would otherwise stop the chain with PowerShell's
 * raw "not a valid application" exception, so the file is only trusted after
 * verifying its PE magic bytes — an intercepting device serving HTML is
 * reported as a connectivity problem rather than executed.
 */
export function buildInstallCommands(opts: InstallCommandOptions): InstallCommands {
  const apiUrl = opts.apiUrl.replace(/\/+$/, '');
  const ghBase = opts.ghBase.replace(/\/+$/, '');
  const { token, enrollmentSecret } = opts;

  // The MZ-magic check is the Windows analog of the unix shebang check: a
  // captive portal's 200 HTML saved as bl4ck-agent.exe would otherwise stop
  // the chain with PowerShell's raw "not a valid application" exception
  // (which never sets $LASTEXITCODE — the process fails to start). The
  // $LASTEXITCODE throws cover agent steps that DO run but fail, since
  // native exe exit codes do not trip $ErrorActionPreference.
  const winSecretFlag = enrollmentSecret ? ` --enrollment-secret "${enrollmentSecret}"` : '';
  const winThrow = (step: string) => `if($LASTEXITCODE){throw "BL4CK: ${step} failed (exit code $LASTEXITCODE)"}`;
  const winMzCheck =
    `$b=[IO.File]::ReadAllBytes("$pwd\\bl4ck-agent.exe"); ` +
    `if($b.Length -lt 2 -or $b[0] -ne 0x4D -or $b[1] -ne 0x5A)` +
    `{throw "BL4CK: downloaded file is not a Windows executable - a captive portal or web filter may be intercepting this network"}`;
  const windows =
    `$ErrorActionPreference='Stop'; ` +
    `Invoke-WebRequest -Uri "${ghBase}/bl4ck-agent-windows-amd64.exe" -OutFile bl4ck-agent.exe; ` +
    `${winMzCheck}; ` +
    `.\\bl4ck-agent.exe service install; ${winThrow('service install')}; ` +
    `.\\bl4ck-agent.exe enroll "${token}" --server "${apiUrl}"${winSecretFlag}; ${winThrow('enrollment')}; ` +
    `.\\bl4ck-agent.exe service start; ${winThrow('service start')}`;

  return { windows };
}
