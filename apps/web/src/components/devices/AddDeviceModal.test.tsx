import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Force a deterministic navigator.userAgent BEFORE importing the component,
// so `detectUserOS()` resolves to 'windows' regardless of host OS. On macOS
// jsdom's default UA contains "darwin" (which includes "win"), but on Linux
// CI it contains "linux" — without this override, the installer tab would
// not be the default and the UI-level assertions below would all fail.
Object.defineProperty(window.navigator, 'userAgent', {
  configurable: true,
  value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 jsdom/test',
});

import AddDeviceModal from './AddDeviceModal';
import { fetchWithAuth } from '../../stores/auth';

// --- Mocks ---

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('../../stores/orgStore', () => ({
  useOrgStore: vi.fn(),
}));

vi.mock('../shared/Toast', () => ({
  showToast: vi.fn(),
}));

vi.mock('@/lib/navigation', () => ({
  navigateTo: vi.fn(),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

import { useOrgStore } from '../../stores/orgStore';
const useOrgStoreMock = vi.mocked(useOrgStore);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
    blob: vi.fn().mockResolvedValue(new Blob(['binary'])),
  }) as unknown as Response;

const SITE_A = { id: 'site-aaa-111', orgId: 'org-111', name: 'HQ Office', createdAt: '2026-01-01', deviceCount: 5 };
const SITE_B = { id: 'site-bbb-222', orgId: 'org-111', name: 'Branch Office', createdAt: '2026-01-02', deviceCount: 3 };

function setOrgStore(overrides: Partial<ReturnType<typeof useOrgStore>> = {}) {
  useOrgStoreMock.mockReturnValue({
    currentPartnerId: 'partner-1',
    currentOrgId: 'org-111',
    currentSiteId: 'site-aaa-111',
    partners: [],
    organizations: [],
    sites: [SITE_A, SITE_B],
    isLoading: false,
    error: null,
    setPartner: vi.fn(),
    setOrganization: vi.fn(),
    setSite: vi.fn(),
    fetchPartners: vi.fn(),
    fetchOrganizations: vi.fn(),
    fetchSites: vi.fn(),
    clearOrgContext: vi.fn(),
    ...overrides,
  } as ReturnType<typeof useOrgStore>);
}

// Mock clipboard
Object.assign(navigator, {
  clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
});

// Mock URL.createObjectURL / revokeObjectURL
global.URL.createObjectURL = vi.fn(() => 'blob:http://localhost/fake');
global.URL.revokeObjectURL = vi.fn();

// NOTE: jsdom on macOS reports UA "Mozilla/5.0 (darwin) ..." — "darwin"
// contains the substring "win", so detectUserOS() returns 'windows'.
// This means the installer tab is active by default and selectedPlatform is 'windows'.

/** Find the action button labelled "Download Installer" (not the tab). */
function getDownloadButton(): HTMLElement {
  // The tab button and the action button both contain text "Download Installer".
  // The action button has the wider/primary class; use getAllByText and pick the
  // one inside the form area (the one with the download icon / w-full class).
  const all = screen.getAllByText(/Download Installer/);
  // Action button has class 'w-full'; tab button does not.
  const actionBtn = all.find((el) => el.className.includes('w-full'));
  if (actionBtn) return actionBtn;
  // Fallback: return the last one (action button comes after tab button in DOM)
  return all[all.length - 1];
}

describe('AddDeviceModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setOrgStore();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders site selector with org sites', () => {
    render(<AddDeviceModal isOpen onClose={vi.fn()} />);

    const select = screen.getByLabelText('Site');
    expect(select).toBeDefined();

    const options = select.querySelectorAll('option');
    expect(options).toHaveLength(2);
    expect(options[0].textContent).toBe('HQ Office');
    expect(options[1].textContent).toBe('Branch Office');
  });

  it('shows no-sites warning when org has no sites', () => {
    setOrgStore({ sites: [] });

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);

    expect(screen.getByText(/No sites available/)).toBeDefined();
  });

  it('does not render content when modal is closed', () => {
    render(<AddDeviceModal isOpen={false} onClose={vi.fn()} />);

    expect(screen.queryByText('Add New Device')).toBeNull();
  });

  it('shows only the Windows installer option (Windows-only build)', () => {
    render(<AddDeviceModal isOpen onClose={vi.fn()} />);

    const windowsButton = screen.getByText('Windows (.msi)');
    expect(windowsButton.className).toContain('bg-primary');

    // macOS/Linux installers were removed — the option must not render.
    expect(screen.queryByText('macOS (.zip)')).toBeNull();
  });

  it('renders the MSI/EXE format toggle defaulting to MSI', () => {
    render(<AddDeviceModal isOpen onClose={vi.fn()} />);

    const msi = screen.getByTestId('installer-format-msi');
    const exe = screen.getByTestId('installer-format-exe');
    expect(msi.textContent).toContain('MSI');
    expect(exe.textContent).toContain('EXE');
    // MSI is selected by default.
    expect(msi.getAttribute('aria-checked')).toBe('true');
    expect(exe.getAttribute('aria-checked')).toBe('false');
  });

  it('downloads installer on button click (defaults to format=msi)', async () => {
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/enrollment-keys') {
        return makeJsonResponse({ id: 'key-123', key: 'raw-key-abc' }, true, 201);
      }
      if (url.startsWith('/enrollment-keys/key-123/installer/')) {
        return makeJsonResponse(null, true);
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);

    fireEvent.click(getDownloadButton());

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledTimes(2);
    });

    const createCall = fetchWithAuthMock.mock.calls[0];
    expect(String(createCall[0])).toBe('/enrollment-keys');
    const createBody = JSON.parse((createCall[1] as RequestInit).body as string);
    expect(createBody.siteId).toBe('site-aaa-111');
    // Device count / expiry are fixed server-side and no longer sent.
    expect(createBody.ttlMinutes).toBeUndefined();
    expect(createBody.count).toBeUndefined();

    // Default format flows to the installer download URL; count/ttl are gone.
    const dlCall = fetchWithAuthMock.mock.calls[1];
    expect(String(dlCall[0])).toContain('format=msi');
    expect(String(dlCall[0])).not.toContain('ttlMinutes');
    expect(String(dlCall[0])).not.toContain('count=');
  });

  it('sends format=exe when the EXE installer is selected', async () => {
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/enrollment-keys') {
        return makeJsonResponse({ id: 'key-123', key: 'raw-key-abc' }, true, 201);
      }
      if (url.startsWith('/enrollment-keys/key-123/installer/')) {
        return makeJsonResponse(null, true);
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);

    fireEvent.click(screen.getByTestId('installer-format-exe'));
    fireEvent.click(getDownloadButton());

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledTimes(2);
    });

    const dlCall = fetchWithAuthMock.mock.calls[1];
    expect(String(dlCall[0])).toContain('format=exe');
  });

  it('generates a public link on button click', async () => {
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/enrollment-keys') {
        return makeJsonResponse({ id: 'key-456', key: 'raw-key-def' }, true, 201);
      }
      if (url === '/enrollment-keys/key-456/installer-link') {
        return makeJsonResponse({
          url: 'https://api.example.com/api/v1/enrollment-keys/public-download/windows?h=dlh_abc123',
          expiresAt: '2026-04-14T00:00:00Z',
          maxUsage: 1,
          platform: 'windows',
          childKeyId: 'child-key-789',
        });
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);

    fireEvent.click(screen.getByText('Generate Link'));

    await waitFor(() => {
      expect(screen.getByDisplayValue(/public-download/)).toBeDefined();
    });

    expect(screen.getByText(/Enrolls up to 1000 devices/)).toBeDefined();

    // Count / expiry are fixed server-side and no longer sent on either call.
    const createCall = fetchWithAuthMock.mock.calls[0];
    expect(JSON.parse((createCall[1] as RequestInit).body as string).ttlMinutes)
      .toBeUndefined();
    const linkCall = fetchWithAuthMock.mock.calls[1];
    expect(String(linkCall[0])).toBe('/enrollment-keys/key-456/installer-link');
    const linkBody = JSON.parse((linkCall[1] as RequestInit).body as string);
    expect(linkBody.ttlMinutes).toBeUndefined();
    expect(linkBody.count).toBeUndefined();
    expect(linkBody.format).toBe('msi');
  });

  it('copies generated link to clipboard', async () => {
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/enrollment-keys') {
        return makeJsonResponse({ id: 'key-456' }, true, 201);
      }
      if (url.includes('/installer-link')) {
        return makeJsonResponse({
          url: 'https://api.example.com/public-download/windows?h=dlh_abc',
          expiresAt: null,
          maxUsage: 1,
          platform: 'windows',
          childKeyId: 'child-1',
        });
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);

    fireEvent.click(screen.getByText('Generate Link'));

    const copyButton = await screen.findByText('Copy');
    fireEvent.click(copyButton);

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        expect.stringContaining('public-download')
      );
    });
  });

  it('shows error when download fails', async () => {
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/enrollment-keys') {
        return makeJsonResponse({ id: 'key-err' }, true, 201);
      }
      if (url.includes('/installer/')) {
        return makeJsonResponse({ error: 'Template MSI not available' }, false, 503);
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);

    fireEvent.click(getDownloadButton());

    await waitFor(() => {
      expect(screen.getByText(/Template MSI not available/)).toBeDefined();
    });
  });

  it('shows MFA warning when enrollment key creation returns 403 mfa required', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({ error: 'MFA required' }, false, 403)
    );

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);

    fireEvent.click(getDownloadButton());

    await waitFor(() => {
      expect(screen.getByText(/Multi-factor authentication is required/)).toBeDefined();
    });
  });

  it('shows error when link generation fails', async () => {
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/enrollment-keys') {
        return makeJsonResponse({ id: 'key-link-err' }, true, 201);
      }
      if (url.includes('/installer-link')) {
        return makeJsonResponse({ error: 'macOS PKG not available' }, false, 503);
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);

    fireEvent.click(screen.getByText('Generate Link'));

    await waitFor(() => {
      expect(screen.getByText(/macOS PKG not available/)).toBeDefined();
    });
  });

  it('fetches onboarding token when CLI tab is clicked', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({ token: 'test-token-xyz', enrollmentSecret: 'secret-abc' })
    );

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);

    // Installer tab is active by default (jsdom UA "darwin" contains "win")
    // Click CLI Commands tab to trigger lazy-load
    fireEvent.click(screen.getByText('CLI Commands'));

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledWith(
        '/devices/onboarding-token',
        // #1108: the request now carries a device count → maxUsage.
        // #2777: …and an explicit TTL (default 24h) with the JSON content type
        // the route's strict validator requires.
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ count: 1, ttlMinutes: 1440 }),
        })
      );
    });

    await waitFor(() => {
      expect(screen.getByText('test-token-xyz')).toBeDefined();
    });
  });

  it('requests a multi-use token after the operator raises the device count (#1108)', async () => {
    // Initial single-device fetch on tab open.
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({ token: 'token-single', maxUsage: 1, expiresAt: new Date(Date.now() + 3600_000).toISOString() })
    );

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('CLI Commands'));

    await waitFor(() => {
      expect(screen.getByText('token-single')).toBeDefined();
    });

    // Operator bumps the count and regenerates → server returns a 5-use token.
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({ token: 'token-multi', maxUsage: 5, expiresAt: new Date(Date.now() + 3600_000).toISOString() })
    );

    const countInput = screen.getByLabelText('Number of devices') as HTMLInputElement;
    fireEvent.change(countInput, { target: { value: '5' } });
    fireEvent.click(screen.getByText('Generate new token'));

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenLastCalledWith(
        '/devices/onboarding-token',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ count: 5, ttlMinutes: 1440 }),
        })
      );
    });

    await waitFor(() => {
      expect(screen.getByText('token-multi')).toBeDefined();
      expect(screen.getByText(/Valid for 5 device enrollments/)).toBeDefined();
    });
  });

  it('shows the real token expiry instead of a hard-coded "24 hours" (#1108)', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({
        token: 'token-exp',
        maxUsage: 1,
        // ~1 hour out → formatTokenExpiry renders "in about 1 hour".
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      })
    );

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('CLI Commands'));

    await waitFor(() => {
      expect(screen.getByText('token-exp')).toBeDefined();
    });

    // The corrected, server-derived copy is shown…
    expect(screen.getByText(/expires in about 1 hour/)).toBeDefined();
    // …and the old misleading hard-coded string is gone.
    expect(screen.queryByText(/expires in 24 hours/)).toBeNull();
  });

  it('sends the selected expiry on the CLI onboarding-token request', async () => {
    fetchWithAuthMock.mockImplementation(async () =>
      new Response(JSON.stringify({
        token: 'enroll_abc', maxUsage: 1,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        enrollmentSecretMode: 'none', additionalSecretRequired: false,
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );

    render(<AddDeviceModal isOpen onClose={() => {}} />);
    await userEvent.click(screen.getByTestId('tab-cli'));
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    fetchWithAuthMock.mockClear();

    await userEvent.selectOptions(screen.getByTestId('cli-link-ttl'), '10080');
    await userEvent.click(screen.getByTestId('cli-regenerate-token'));

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    const call = fetchWithAuthMock.mock.calls[0];
    expect(String(call[0])).toBe('/devices/onboarding-token');
    const init = call[1] as RequestInit;
    expect(JSON.parse(init.body as string)).toMatchObject({ ttlMinutes: 10080 });
    expect((init.headers as Record<string, string>)['Content-Type'])
      .toBe('application/json');
  });
});

describe('AddDeviceModal - resolved enrollment defaults (#2776)', () => {
  const optionLabels = (testId: string): (string | null)[] =>
    Array.from((screen.getByTestId(testId) as HTMLSelectElement).options).map(
      (o) => o.textContent,
    );

  beforeEach(() => {
    vi.clearAllMocks();
    setOrgStore();
  });

  // ------------------------------------------------------------------
  // BL4CK fork: the INSTALLER tab has no device-count input and no
  // link-expiry select. Upstream's #2776 suite drives both controls; here
  // their absence IS the contract. Installer downloads and installer links
  // are fixed server-side at 1000 devices / 365 days (see
  // INSTALLER_FIXED_MAX_DEVICES / INSTALLER_FIXED_TTL_MINUTES in
  // apps/api/src/routes/enrollmentKeys.ts), so the resolved partner/org
  // defaults must NOT reach that tab at all. The CLI tab still honours them,
  // and those upstream assertions are kept below.
  // ------------------------------------------------------------------

  it('exposes no device-count or link-expiry control on the installer tab', () => {
    setOrgStore({
      enrollmentDefaults: { ttlMinutes: 10080, deviceCount: 25, maxTtlMinutes: 43200 },
    });

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);

    expect(screen.queryByTestId('link-ttl')).toBeNull();
    expect(screen.queryByTestId('device-count')).toBeNull();
    // The format toggle is the only installer-tab choice that remains.
    expect(screen.getByTestId('installer-format-msi')).toBeDefined();
    expect(screen.getByTestId('installer-format-exe')).toBeDefined();
  });

  it('never puts count or ttlMinutes on the installer download URL, whatever the resolved defaults say', async () => {
    // A low partner cap must not shorten the fixed installer: the client sends
    // nothing, so the server applies its fixed 1000-device / 365-day contract.
    setOrgStore({
      enrollmentDefaults: { ttlMinutes: 60, deviceCount: 1, maxTtlMinutes: 60 },
    });

    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/enrollment-keys') {
        return makeJsonResponse({ id: 'key-fixed', key: 'raw' }, true, 201);
      }
      return makeJsonResponse(null, true);
    });

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);

    fireEvent.click(getDownloadButton());
    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledTimes(2);
    });

    const downloadUrl = String(fetchWithAuthMock.mock.calls[1][0]);
    expect(downloadUrl).toContain('/installer/windows');
    expect(downloadUrl).not.toContain('ttlMinutes');
    expect(downloadUrl).not.toContain('count=');
  });

  it('never puts count or ttlMinutes in the installer-link request body', async () => {
    setOrgStore({
      enrollmentDefaults: { ttlMinutes: 60, deviceCount: 1, maxTtlMinutes: 60 },
    });

    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/enrollment-keys') {
        return makeJsonResponse({ id: 'key-link', key: 'raw' }, true, 201);
      }
      return makeJsonResponse({ shortUrl: 'https://x.test/s/abc' }, true);
    });

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);
    fireEvent.click(screen.getByText(/Generate Link/));

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledTimes(2);
    });

    const linkCall = fetchWithAuthMock.mock.calls[1];
    expect(String(linkCall[0])).toContain('/installer-link');
    const body = JSON.parse(String((linkCall[1] as RequestInit).body));
    expect(body).toEqual({ platform: 'windows', format: 'msi' });
  });

  it('seeds the CLI tab from the resolved defaults', async () => {
    setOrgStore({
      enrollmentDefaults: { ttlMinutes: 10080, deviceCount: 25, maxTtlMinutes: 43200 },
    });
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({ token: 'cli-token', maxUsage: 25 }),
    );

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('tab-cli'));

    await waitFor(() => {
      expect(screen.getByText('cli-token')).toBeDefined();
    });

    expect((screen.getByTestId('cli-link-ttl') as HTMLSelectElement).value).toBe('10080');
    expect((screen.getByTestId('cli-device-count') as HTMLInputElement).value).toBe('25');
    // 90 days and 1 year are above the 30-day cap and must not be offerable.
    expect(optionLabels('cli-link-ttl')).toEqual(['1 hour', '24 hours', '7 days', '30 days']);

    expect(fetchWithAuthMock).toHaveBeenCalledWith(
      '/devices/onboarding-token',
      expect.objectContaining({
        body: JSON.stringify({ count: 25, ttlMinutes: 10080 }),
      }),
    );
  });

  it('falls back to the product defaults on the CLI tab when the store has not resolved them yet', async () => {
    setOrgStore({ enrollmentDefaults: null });
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({ token: 'cli-token', maxUsage: 1 }),
    );

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('tab-cli'));

    await waitFor(() => {
      expect(screen.getByText('cli-token')).toBeDefined();
    });

    expect((screen.getByTestId('cli-link-ttl') as HTMLSelectElement).value).toBe('1440');
    expect((screen.getByTestId('cli-device-count') as HTMLInputElement).value).toBe('1');
    expect(optionLabels('cli-link-ttl')).toEqual([
      '1 hour',
      '24 hours',
      '7 days',
      '30 days',
      '90 days',
      '1 year',
    ]);
  });

  it('clamps a CLI resolved default that sits above the cap instead of submitting a 400', async () => {
    setOrgStore({
      enrollmentDefaults: { ttlMinutes: 525600, deviceCount: 1, maxTtlMinutes: 10080 },
    });
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({ token: 'cli-token', maxUsage: 1 }),
    );

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('tab-cli'));

    await waitFor(() => {
      expect(screen.getByText('cli-token')).toBeDefined();
    });

    expect((screen.getByTestId('cli-link-ttl') as HTMLSelectElement).value).toBe('10080');
  });

  it('renders a non-canonical CLI default as its own option so display matches what is submitted', async () => {
    // 20000 is under the 43200 cap but is not a canonical option. Filtering it
    // out would leave the select matching nothing - the browser shows "1 hour"
    // while the request still carries 20000.
    setOrgStore({
      enrollmentDefaults: { ttlMinutes: 20000, deviceCount: 1, maxTtlMinutes: 43200 },
    });
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({ token: 'cli-token', maxUsage: 1 }),
    );

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('tab-cli'));

    await waitFor(() => {
      expect(screen.getByText('cli-token')).toBeDefined();
    });

    expect((screen.getByTestId('cli-link-ttl') as HTMLSelectElement).value).toBe('20000');
    expect(
      [...(screen.getByTestId('cli-link-ttl') as HTMLSelectElement).options].map((o) => o.value),
    ).toEqual(['60', '1440', '10080', '20000', '43200']);
  });

  it('offers the cap itself when it sits below every canonical option', async () => {
    setOrgStore({
      enrollmentDefaults: { ttlMinutes: 30, deviceCount: 1, maxTtlMinutes: 30 },
    });
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({ token: 'cli-token', maxUsage: 1 }),
    );

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('tab-cli'));

    await waitFor(() => {
      expect(screen.getByText('cli-token')).toBeDefined();
    });

    expect((screen.getByTestId('cli-link-ttl') as HTMLSelectElement).value).toBe('30');
    expect(optionLabels('cli-link-ttl')).toEqual(['in about 30 minutes']);
  });
});
