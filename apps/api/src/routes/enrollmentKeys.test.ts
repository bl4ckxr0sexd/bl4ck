import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "crypto";

// ============================================================
// Mocks — must appear before any `import` of the source
// ============================================================

vi.mock("../db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },

  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(
    async (_ctx: unknown, fn: () => Promise<unknown>) => fn(),
  ),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock("../db/schema", () => ({
  enrollmentKeys: {},
  installerBootstrapTokens: {},
}));

vi.mock("../db/schema/orgs", () => ({
  sites: {},
  enrollmentKeys: {},
}));

vi.mock("../db/schema/installerBootstrapTokens", () => ({
  installerBootstrapTokens: {},
}));

vi.mock("../services/installerBootstrapToken", () => ({
  generateBootstrapToken: vi.fn(() => "ABC1234567"),
  bootstrapTokenExpiresAt: vi.fn(() => new Date("2026-04-20T00:00:00.000Z")),
  BOOTSTRAP_TOKEN_PATTERN: /^[A-Z0-9]{10}$/,
}));

vi.mock("../middleware/auth", () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set("auth", {
      scope: "system",
      orgId: null,
      user: { id: "user-system", email: "system@example.com" },
      canAccessOrg: () => true,
      accessibleOrgIds: [],
    });
    return next();
  }),
  requireScope: () => vi.fn((_c: any, next: any) => next()),
  requirePermission: () => vi.fn((_c: any, next: any) => next()),
  requireMfa: () => vi.fn((_c: any, next: any) => next()),
}));

vi.mock("../services/permissions", () => ({
  PERMISSIONS: {
    ORGS_READ: { resource: "orgs", action: "read" },
    ORGS_WRITE: { resource: "orgs", action: "write" },
  },
}));

vi.mock("../services/auditService", () => ({
  createAuditLogAsync: vi.fn(),
}));

vi.mock("../services/enrollmentKeySecurity", () => ({
  hashEnrollmentKey: vi.fn((raw: string) => `hashed:${raw}`),
  hashEnrollmentKeyCandidates: vi.fn((raw: string) => [`hashed:${raw}`]),
}));

vi.mock("../services/msiSigning", () => ({
  MsiSigningService: { fromEnv: vi.fn(() => null) },
}));

vi.mock("../services/installerBuilder", () => ({
  buildWindowsInstallerZip: vi.fn(async () => Buffer.from("windows-zip")),
  fetchRegularMsi: vi.fn(async () => Buffer.from("regular-msi")),
  // The fork's enrollmentKeys.ts imports the EXE pair too — a mock factory that
  // omits them makes Vitest throw "No export is defined on the mock" at import
  // time, taking the whole suite down.
  fetchSetupExe: vi.fn(async () => Buffer.from("setup-exe")),
  serveWindowsBootstrapMsi: vi.fn((c: any, args: { msi: Buffer; token: string; apiHost: string }) => {
    const filename = `Bl4ck Agent (${args.token}@${args.apiHost}).msi`;
    c.header("Content-Type", "application/octet-stream");
    c.header("Content-Disposition", `attachment; filename="${filename}"`);
    c.header("Content-Length", String(args.msi.length));
    c.header("Cache-Control", "no-store");
    return c.body(args.msi);
  }),
  serveWindowsBootstrapExe: vi.fn((c: any, args: { exe: Buffer; token: string; apiHost: string }) => {
    const filename = `Bl4ck Setup (${args.token}@${args.apiHost}).exe`;
    c.header("Content-Type", "application/octet-stream");
    c.header("Content-Disposition", `attachment; filename="${filename}"`);
    c.header("Content-Length", String(args.exe.length));
    c.header("Cache-Control", "no-store");
    return c.body(args.exe);
  }),
}));

vi.mock("../services/rate-limit", () => ({
  rateLimiter: vi.fn(async () => ({
    allowed: true,
    remaining: 10,
    resetAt: new Date(),
  })),
}));

const issueDownloadHandleMock = vi.fn(async () => `dlh_${"1".repeat(32)}`);
const consumeDownloadHandleMock = vi.fn(async () => "a".repeat(64));
vi.mock("../services/downloadHandle", () => ({
  issueDownloadHandle: (...args: unknown[]) =>
    issueDownloadHandleMock(...(args as [])),
  consumeDownloadHandle: (...args: unknown[]) =>
    consumeDownloadHandleMock(...(args as [])),
}));

// H6: dynamic-import path inside serveInstaller pulls getRedis from '../services'.
// Provide a controllable mock so we can test fail-closed semantics.
const mockGetRedis = vi.fn(() => ({}) as any);
vi.mock("../services", () => ({
  getRedis: () => mockGetRedis(),
}));

// Partner-cap enforcement (#2776 task 3.4). Mocked at the wiring level — the
// cap-computation/message logic itself is unit-tested directly against
// resolveEnrollmentDefaults/getEnrollmentDefaultsForOrg, so these route tests
// only need to prove the route calls assertTtlWithinCap with the right org id
// and TTL, and reacts correctly to its null/error return.
const assertTtlWithinCapMock = vi.fn(
  async (_orgId: string, _ttlMinutes: number | undefined) => null as string | null,
);
// clampTtlToCap (fix round 3, #2776): the CLAMP-shaped sibling of
// assertTtlWithinCap, used by mintChildEnrollmentKey/redeemShortCode/the
// /s/:code redemption/issueBootstrapTokenForKey for server-constant TTLs on
// paths with no interactive caller. Permissive default (returns ttlMinutes
// unchanged) models "no partner cap configured".
const clampTtlToCapMock = vi.fn(
  async (_orgId: string, ttlMinutes: number) => ttlMinutes,
);
vi.mock("../services/enrollmentDefaults", () => ({
  assertTtlWithinCap: (...args: [string, number | undefined]) =>
    assertTtlWithinCapMock(...args),
  clampTtlToCap: (...args: [string, number]) => clampTtlToCapMock(...args),
}));

// ============================================================
// Import after mocks
// ============================================================
import {
  enrollmentKeyRoutes,
  publicEnrollmentRoutes,
  publicShortLinkRoutes,
  redeemShortCode,
} from "./enrollmentKeys";
import { db, withSystemDbAccessContext } from "../db";
import { createAuditLogAsync } from "../services/auditService";
import { MsiSigningService } from "../services/msiSigning";
import * as installerBootstrapTokenIssuance from "../services/installerBootstrapTokenIssuance";

/**
 * Configure the mocked partner-cap gate for the current test. Mirrors the
 * real assertTtlWithinCap contract: null when ttlMinutes is undefined or at/
 * under the cap, an error string naming the cap when it's exceeded.
 */
function mockEnrollmentDefaults(opts: { maxTtlMinutes: number }) {
  assertTtlWithinCapMock.mockImplementation(
    async (_orgId: string, ttlMinutes: number | undefined) => {
      if (ttlMinutes === undefined) return null;
      return ttlMinutes > opts.maxTtlMinutes
        ? `ttlMinutes exceeds the partner maximum of ${opts.maxTtlMinutes} minutes`
        : null;
    },
  );
  clampTtlToCapMock.mockImplementation(
    async (_orgId: string, ttlMinutes: number) => Math.min(ttlMinutes, opts.maxTtlMinutes),
  );
}

// ============================================================
// Helpers
// ============================================================

const ORG_ID = randomUUID();
const SITE_ID = randomUUID();
const KEY_ID = randomUUID();
const CHILD_KEY_ID = randomUUID();

function makeKeyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: KEY_ID,
    orgId: ORG_ID,
    siteId: SITE_ID,
    name: "Test Key",
    key: "hashed:rawkey",
    keySecretHash: null,
    shortCode: null,
    installerPlatform: null,
    maxUsage: 10,
    usageCount: 0,
    expiresAt: new Date(Date.now() + 3_600_000), // 1 hour from now
    createdBy: "user-system",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeChildKeyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CHILD_KEY_ID,
    orgId: ORG_ID,
    siteId: SITE_ID,
    name: "Test Key (link)",
    key: "hashed:childkey",
    keySecretHash: null,
    shortCode: "Ab3De5Fg7H",
    installerPlatform: "windows",
    maxUsage: 1,
    usageCount: 0,
    expiresAt: new Date(Date.now() + 3_600_000),
    createdBy: "user-system",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// Runs before every per-describe `vi.clearAllMocks()` (outer beforeEach hooks
// fire before inner ones), so each test starts from the permissive default —
// clearAllMocks only wipes call history, not mockImplementation, so a test
// that calls mockEnrollmentDefaults() would otherwise leak its cap into every
// later test in the file.
beforeEach(() => {
  assertTtlWithinCapMock.mockReset();
  assertTtlWithinCapMock.mockImplementation(async () => null);
  clampTtlToCapMock.mockReset();
  clampTtlToCapMock.mockImplementation(async (_orgId: string, ttlMinutes: number) => ttlMinutes);
});

// ============================================================
// Tests
// ============================================================

describe("POST /enrollment-keys/:id/installer-link", () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(MsiSigningService.fromEnv).mockReturnValue(null);
    process.env.PUBLIC_API_URL = "https://api.example.com";
    app = new Hono();
    app.route("/enrollment-keys", enrollmentKeyRoutes);
  });

  it("returns shortUrl in response", async () => {
    const parentRow = makeKeyRow();
    const childRow = makeChildKeyRow();

    // First select: look up parent key
    vi.mocked(db.select)
      // allocateShortCode: look up existing short code (not found → unique)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([parentRow]),
          }),
        }),
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

    // insert: create child key
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([childRow]),
      }),
    } as any);

    const res = await app.request(`/enrollment-keys/${KEY_ID}/installer-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "windows" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.shortUrl).toMatch(/^https?:\/\/.+\/s\/[A-Za-z0-9]{10}$/);
  });

  it("refuses to build an installer when parent key is within 60s of expiry", async () => {
    // Parent with only 30s of life left. Previously the child inherited this
    // and was DOA. Now the route refuses with 410 so the admin can regenerate.
    // NOTE: handler returns 410 before calling db.insert. Using the persistent
    // mockReturnValue here (not mockReturnValueOnce) so unconsumed entries
    // do not leak onto the queue and poison subsequent tests.
    const parentRow = makeKeyRow({
      expiresAt: new Date(Date.now() + 30_000),
    });

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([parentRow]),
        }),
      }),
    } as any);

    const insertValues = vi.fn();
    vi.mocked(db.insert).mockReturnValue({ values: insertValues } as any);

    const res = await app.request(`/enrollment-keys/${KEY_ID}/installer-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "windows" }),
    });
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.error).toContain("expires too soon");
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("child key gets the fixed 1-year TTL when no ttlMinutes is supplied", async () => {
    // Parent has 1h remaining (plenty) — child insert should fire with a
    // fresh expiresAt, independent of parent.
    //
    // BL4CK fork: upstream's default here is CHILD_ENROLLMENT_KEY_TTL_MINUTES
    // (24h) run through clampTtlToCap. The fork defaults an operator-omitted
    // TTL to INSTALLER_FIXED_TTL_MINUTES (525_600 = 365 days) UNCLAMPED, so a
    // partner cap can never silently truncate a default installer link. An
    // EXPLICITLY supplied ttlMinutes is still clamped (test below).
    const parentRow = makeKeyRow({
      expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1h
    });
    const childRow = makeChildKeyRow();

    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([parentRow]),
          }),
        }),
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

    const insertValues = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([childRow]),
    });
    vi.mocked(db.insert).mockReturnValue({ values: insertValues } as any);

    const before = Date.now();
    const res = await app.request(`/enrollment-keys/${KEY_ID}/installer-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "windows" }),
    });
    const after = Date.now();
    expect(res.status).toBe(200);

    expect(insertValues).toHaveBeenCalledTimes(1);
    const firstCall = insertValues.mock.calls[0]!;
    const insertedRow = firstCall[0] as { expiresAt: Date };
    const childExpiryMs = insertedRow.expiresAt.getTime();
    const YEAR_MS = 525_600 * 60 * 1000;
    // ~365 days out, well above the parent's 1h remaining.
    expect(childExpiryMs).toBeGreaterThan(before + YEAR_MS - 60_000);
    expect(childExpiryMs).toBeLessThan(after + YEAR_MS + 60_000);
    // Explicitly NOT the parent's expiresAt
    expect(childExpiryMs).not.toBe(parentRow.expiresAt.getTime());
    // The fixed default must NOT be routed through the partner clamp.
    expect(clampTtlToCapMock).not.toHaveBeenCalled();
  });

  it("child key honors the ttlMinutes from the request body (per-link picker)", async () => {
    // Admin picked "7 days" in the Add Device modal. The child key (the
    // thing the short link redeems) must get a fresh 7d window measured
    // from mint time — not the deployment default, not the parent's life.
    const parentRow = makeKeyRow({
      expiresAt: new Date(Date.now() + 60 * 60 * 1000), // parent: 1h
    });
    const childRow = makeChildKeyRow();

    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([parentRow]),
          }),
        }),
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

    const insertValues = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([childRow]),
    });
    vi.mocked(db.insert).mockReturnValue({ values: insertValues } as any);

    const ttlMinutes = 10080; // 7 days
    const before = Date.now();
    const res = await app.request(`/enrollment-keys/${KEY_ID}/installer-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "windows", ttlMinutes }),
    });
    const after = Date.now();
    expect(res.status).toBe(200);

    expect(insertValues).toHaveBeenCalledTimes(1);
    const insertedRow = insertValues.mock.calls[0]![0] as { expiresAt: Date };
    const childExpiryMs = insertedRow.expiresAt.getTime();
    const ttlMs = ttlMinutes * 60 * 1000;
    expect(childExpiryMs).toBeGreaterThanOrEqual(before + ttlMs - 50);
    expect(childExpiryMs).toBeLessThanOrEqual(after + ttlMs + 50);
  });

  it("shortUrl and url share the same origin", async () => {
    const parentRow = makeKeyRow();
    const childRow = makeChildKeyRow();

    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([parentRow]),
          }),
        }),
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([childRow]),
      }),
    } as any);

    const res = await app.request(`/enrollment-keys/${KEY_ID}/installer-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "windows" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    const urlOrigin = new URL(body.url).origin;
    const shortUrlOrigin = new URL(body.shortUrl).origin;
    expect(urlOrigin).toBe(shortUrlOrigin);
  });

  it("returns 429 when per-user rate limit is exceeded", async () => {
    const { rateLimiter } = await import("../services/rate-limit");
    vi.mocked(rateLimiter).mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: new Date(),
    });

    const res = await app.request(`/enrollment-keys/${KEY_ID}/installer-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "windows" }),
    });
    expect(res.status).toBe(429);
  });

  // #2776 task 3.4 — partner-cap enforcement at the mint route.
  it("rejects a ttlMinutes above the partner cap", async () => {
    mockEnrollmentDefaults({ maxTtlMinutes: 1440 });
    const parentRow = makeKeyRow();

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([parentRow]),
        }),
      }),
    } as any);

    const insertValues = vi.fn();
    vi.mocked(db.insert).mockReturnValue({ values: insertValues } as any);

    const res = await app.request(`/enrollment-keys/${KEY_ID}/installer-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "windows", count: 1, ttlMinutes: 43200 }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("1440");
    expect(insertValues).not.toHaveBeenCalled();
    // The cap check must run after the parent key load, using its orgId.
    expect(assertTtlWithinCapMock).toHaveBeenCalledWith(ORG_ID, 43200);
  });

  it("allows a ttlMinutes at exactly the cap", async () => {
    mockEnrollmentDefaults({ maxTtlMinutes: 1440 });
    const parentRow = makeKeyRow();
    const childRow = makeChildKeyRow();

    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([parentRow]),
          }),
        }),
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([childRow]),
      }),
    } as any);

    const res = await app.request(`/enrollment-keys/${KEY_ID}/installer-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "windows", count: 1, ttlMinutes: 1440 }),
    });

    expect(res.status).toBe(200);
  });

  // BL4CK fork divergence from upstream's #2776 final wave.
  //
  // Upstream clamps the OMITTED-ttlMinutes fallback to the partner cap. The
  // fork does not: an omitted TTL means "give me the standard installer link",
  // and the standard is INSTALLER_FIXED_TTL_MINUTES (365 days). Routing that
  // through the clamp would let a partner cap silently truncate every default
  // link to hours — the exact regression this fork exists to avoid. An
  // EXPLICIT ttlMinutes is still clamped, which is what this test now pins.
  it("routes only an EXPLICIT ttlMinutes through the partner clamp (#2776)", async () => {
    mockEnrollmentDefaults({ maxTtlMinutes: 60 });
    const parentRow = makeKeyRow();
    const childRow = makeChildKeyRow();

    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([parentRow]),
          }),
        }),
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

    let capturedChildValues: Record<string, unknown> | null = null;
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
        capturedChildValues = vals;
        return { returning: vi.fn().mockResolvedValue([childRow]) };
      }),
    } as any);

    const before = Date.now();
    const res = await app.request(`/enrollment-keys/${KEY_ID}/installer-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // EXPLICIT 60 — at the cap. (Anything ABOVE the cap never reaches the
      // clamp: assertTtlWithinCap 400s it first, proven by its own test.)
      body: JSON.stringify({ platform: "windows", count: 1, ttlMinutes: 60 }),
    });
    const after = Date.now();

    expect(res.status).toBe(200);
    // Only the operator's EXPLICIT value reaches the clamp. Critically, the
    // fixed 525_600 default is NEVER handed to it.
    expect(clampTtlToCapMock).toHaveBeenCalledWith(ORG_ID, 60);
    expect(clampTtlToCapMock).not.toHaveBeenCalledWith(ORG_ID, 525_600);
    expect(capturedChildValues).not.toBeNull();
    const expiresAt = (capturedChildValues as unknown as { expiresAt: Date }).expiresAt;
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + 59 * 60 * 1000);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(after + 61 * 60 * 1000);
  });
});

// ============================================================
// GET /s/:code  (publicShortLinkRoutes)
// ============================================================

describe("GET /s/:code", () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(MsiSigningService.fromEnv).mockReturnValue(null);
    process.env.PUBLIC_API_URL = "https://api.example.com";
    app = new Hono();
    app.route("/s", publicShortLinkRoutes);
  });

  it("serves installer for valid code", async () => {
    const shortLinkRow = makeKeyRow({
      shortCode: "abc1234567",
      installerPlatform: "windows",
    });
    const childRow = makeChildKeyRow({ installerPlatform: "windows" });

    // select: look up by shortCode; issueBootstrapTokenForKey also selects the child row
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([shortLinkRow]),
        }),
      }),
    } as any);

    // insert: spawn single-use child key
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([childRow]),
      }),
    } as any);

    // update: atomic usage increment (claimed successfully)
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: KEY_ID }]),
        }),
      }),
    } as any);

    // serveInstaller (Windows) now calls issueBootstrapTokenForKey — spy it
    const issueSpy = vi
      .spyOn(installerBootstrapTokenIssuance, "issueBootstrapTokenForKey")
      .mockResolvedValueOnce({
        id: "btok-1",
        token: "ABC1234567",
        expiresAt: new Date(Date.now() + 3_600_000),
        parentKeyName: "Test Key",
      });

    const res = await app.request("/s/abc1234567");

    expect(res.status).toBe(200);
    const buf = await res.arrayBuffer();
    expect(buf.byteLength).toBeGreaterThan(0);

    issueSpy.mockRestore();
  });

  it("passes createdByUserId: null (never \"\") for the null-creator child key", async () => {
    // Regression: the /s/:code route spawns the child download key with
    // createdBy: null (it has no authenticated user). serveInstaller's Windows
    // branch previously coerced that to "" via `?? ""`, and the empty string
    // failed the uuid cast on insert into installer_bootstrap_tokens.created_by
    // (`invalid input syntax for type uuid: ""`) — every Windows short link 500'd.
    // Match the real route: the child row carries createdBy: null.
    const shortLinkRow = makeKeyRow({
      shortCode: "nullcreator",
      installerPlatform: "windows",
    });
    const childRow = makeChildKeyRow({
      installerPlatform: "windows",
      createdBy: null,
    });

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([shortLinkRow]),
        }),
      }),
    } as any);
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([childRow]),
      }),
    } as any);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: KEY_ID }]),
        }),
      }),
    } as any);

    const issueSpy = vi
      .spyOn(installerBootstrapTokenIssuance, "issueBootstrapTokenForKey")
      .mockResolvedValueOnce({
        id: "btok-2",
        token: "NULLCREAT0",
        expiresAt: new Date(Date.now() + 3_600_000),
        parentKeyName: "Test Key",
      });

    const res = await app.request("/s/nullcreator");

    expect(res.status).toBe(200);
    expect(issueSpy).toHaveBeenCalledWith(
      expect.objectContaining({ createdByUserId: null }),
    );
    // The "" that broke the uuid insert must never be passed.
    expect(issueSpy.mock.calls[0]?.[0]?.createdByUserId).not.toBe("");

    issueSpy.mockRestore();
  });

  // Fix round 3 (#2776): this route mints its own download child key via
  // CHILD_ENROLLMENT_KEY_TTL_MINUTES (default 1440) with no interactive
  // caller (it's the public short-link redemption), so a partner cap below
  // that default must clamp the minted lifetime down, never reject.
  it("clamps the download child key's TTL down when the partner cap is below the default — but leaves maxUsage UNLIMITED", async () => {
    mockEnrollmentDefaults({ maxTtlMinutes: 60 });
    const shortLinkRow = makeKeyRow({
      shortCode: "cappedlink",
      installerPlatform: "windows",
    });

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([shortLinkRow]),
        }),
      }),
    } as any);
    const insertValues = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([makeChildKeyRow({ installerPlatform: "windows" })]),
    });
    vi.mocked(db.insert).mockReturnValue({ values: insertValues } as any);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: KEY_ID }]),
        }),
      }),
    } as any);
    const issueSpy = vi
      .spyOn(installerBootstrapTokenIssuance, "issueBootstrapTokenForKey")
      .mockResolvedValueOnce({
        id: "btok-capped",
        token: "ABC1234567",
        expiresAt: new Date(Date.now() + 3_600_000),
        parentKeyName: "Test Key",
      });

    const before = Date.now();
    const res = await app.request("/s/cappedlink");
    const after = Date.now();

    expect(res.status).toBe(200);
    expect(insertValues).toHaveBeenCalledTimes(1);
    const insertedRow = insertValues.mock.calls[0]![0] as {
      expiresAt: Date;
      maxUsage: number | null;
    };
    // Clamped to the 60-minute cap, NOT the 1440-minute (24h) default.
    expect(insertedRow.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 59 * 60 * 1000);
    expect(insertedRow.expiresAt.getTime()).toBeLessThanOrEqual(after + 60 * 60 * 1000 + 5_000);
    expect(clampTtlToCapMock).toHaveBeenCalledWith(ORG_ID, 1440);
    // BL4CK fork guarantee: the partner TTL cap is an EXPIRY control only. A
    // lowered cap must never turn a reusable installer key into a single-use
    // one (upstream ships `maxUsage: 1` on this insert; we ship
    // CHILD_ENROLLMENT_KEY_MAX_USAGE, which defaults to null = UNLIMITED).
    expect(insertedRow.maxUsage).toBeNull();

    issueSpy.mockRestore();
  });

  it("does not shorten the download child key's TTL when the partner cap is above the default (no-op clamp)", async () => {
    mockEnrollmentDefaults({ maxTtlMinutes: 525_600 });
    const shortLinkRow = makeKeyRow({
      shortCode: "generouscap",
      installerPlatform: "windows",
    });

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([shortLinkRow]),
        }),
      }),
    } as any);
    const insertValues = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([makeChildKeyRow({ installerPlatform: "windows" })]),
    });
    vi.mocked(db.insert).mockReturnValue({ values: insertValues } as any);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: KEY_ID }]),
        }),
      }),
    } as any);
    const issueSpy = vi
      .spyOn(installerBootstrapTokenIssuance, "issueBootstrapTokenForKey")
      .mockResolvedValueOnce({
        id: "btok-generous",
        token: "ABC1234567",
        expiresAt: new Date(Date.now() + 3_600_000),
        parentKeyName: "Test Key",
      });

    const before = Date.now();
    const res = await app.request("/s/generouscap");
    const after = Date.now();

    expect(res.status).toBe(200);
    const insertedRow = insertValues.mock.calls[0]![0] as {
      expiresAt: Date;
      maxUsage: number | null;
    };
    // Unchanged: still the full 1440-minute (24h) default.
    expect(insertedRow.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 1439 * 60 * 1000);
    expect(insertedRow.expiresAt.getTime()).toBeLessThanOrEqual(after + 1441 * 60 * 1000);
    expect(insertedRow.maxUsage).toBeNull();

    issueSpy.mockRestore();
  });

  // BL4CK fork regression guard (#installer-reuse). The /s/:code redemption
  // must mint a REUSABLE child enrollment key. Upstream v0.102.0 ships
  // `maxUsage: 1` on this insert; taking that would silently make every
  // short-link installer single-use.
  it("mints the /s/:code download child key with UNLIMITED maxUsage (never 1)", async () => {
    const shortLinkRow = makeKeyRow({
      shortCode: "reusable01",
      installerPlatform: "windows",
    });

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([shortLinkRow]),
        }),
      }),
    } as any);
    const insertValues = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([makeChildKeyRow({ installerPlatform: "windows" })]),
    });
    vi.mocked(db.insert).mockReturnValue({ values: insertValues } as any);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: KEY_ID }]),
        }),
      }),
    } as any);
    const issueSpy = vi
      .spyOn(installerBootstrapTokenIssuance, "issueBootstrapTokenForKey")
      .mockResolvedValueOnce({
        id: "btok-reusable",
        token: "ABC1234567",
        expiresAt: new Date(Date.now() + 3_600_000),
        parentKeyName: "Test Key",
      });

    const res = await app.request("/s/reusable01");

    expect(res.status).toBe(200);
    const insertedRow = insertValues.mock.calls[0]![0] as { maxUsage: number | null };
    expect(insertedRow.maxUsage).toBeNull();
    expect(insertedRow.maxUsage).not.toBe(1);

    issueSpy.mockRestore();
  });

  it("returns 404 for unknown code", async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as any);

    const res = await app.request("/s/unknowncode");
    expect(res.status).toBe(404);
  });

  it("returns 410 for expired key", async () => {
    const expiredRow = makeKeyRow({
      shortCode: "expiredcode",
      installerPlatform: "windows",
      expiresAt: new Date(Date.now() - 10_000), // past
    });

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([expiredRow]),
        }),
      }),
    } as any);

    // Atomic update returns empty because expiry check in WHERE clause fails
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as any);

    const res = await app.request("/s/expiredcode");
    expect(res.status).toBe(410);
  });

  it("returns 410 when atomic update returns empty (usage exhausted at increment)", async () => {
    const shortLinkRow = makeKeyRow({
      shortCode: "fullcode567",
      installerPlatform: "windows",
      maxUsage: 1,
      usageCount: 0, // pre-check passes...
    });
    const childRow = makeChildKeyRow({ installerPlatform: "windows" });

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([shortLinkRow]),
        }),
      }),
    } as any);

    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([childRow]),
      }),
    } as any);

    // Atomic update returns empty → another request beat us to it
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]), // empty = limit hit
        }),
      }),
    } as any);

    // delete: clean up orphaned child key
    vi.mocked(db.delete).mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    } as any);

    const res = await app.request("/s/fullcode567");
    expect(res.status).toBe(410);
  });

  it("does not spawn a child key for an already-expired short-link parent", async () => {
    const expiredRow = makeKeyRow({
      installerPlatform: "windows",
      shortCode: "test123",
      expiresAt: new Date(Date.now() - 1000),
    });

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([expiredRow]),
        }),
      }),
    } as any);

    // Atomic update should fail immediately due to expiry in WHERE clause
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]), // empty = expired
        }),
      }),
    } as any);

    const insertValues = vi.fn();
    vi.mocked(db.insert).mockReturnValue({ values: insertValues } as any);

    const res = await app.request("/s/test123");
    expect(res.status).toBe(410);
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("returns 404 for code longer than 12 chars", async () => {
    const res = await app.request("/s/this-code-is-way-too-long-for-sure");
    expect(res.status).toBe(404);
  });

  it("returns 404 when row has null installerPlatform", async () => {
    const rowNoPlatform = makeKeyRow({
      shortCode: "noplatform1",
      installerPlatform: null,
    });

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([rowNoPlatform]),
        }),
      }),
    } as any);

    const res = await app.request("/s/noplatform1");
    expect(res.status).toBe(404);
  });

  // Task 32 (public HIGH-1): per-(short-code OR enrollment-key id) cap of
  // 30/hour on the installer signing service. The per-IP 10/min cap by itself
  // is bypassable via IP rotation; this cap binds the spend per enrollment
  // link regardless of source IP.
  it("returns 429 when per-short-code signing cap (30/hr) is reached, regardless of IP", async () => {
    const shortLinkRow = makeKeyRow({
      shortCode: "rlcode12345",
      installerPlatform: "windows",
    });

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([shortLinkRow]),
        }),
      }),
    } as any);

    // First rateLimiter call = per-short-code bucket. Block it.
    const { rateLimiter } = await import("../services/rate-limit");
    vi.mocked(rateLimiter).mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: new Date(Date.now() + 3_600_000),
    });

    const res = await app.request("/s/rlcode12345", {
      headers: { "cf-connecting-ip": "198.51.100.99" },
    });
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toMatch(/rate limit/i);

    // Cap MUST be checked before atomic-claim — otherwise an attacker
    // would burn usage slots even after being rate-limited.
    expect(db.update).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();

    // The bucket key must be derived from the short-code (not the IP),
    // so IP rotation cannot reset the budget.
    const calls = vi.mocked(rateLimiter).mock.calls;
    const firstKey = calls[0]?.[1] as string;
    expect(firstKey).toContain("rlcode12345");
    expect(firstKey).not.toContain("198.51.100.99");
  });

  it("per-short-code cap uses windowed bucket (30/hour)", async () => {
    const shortLinkRow = makeKeyRow({
      shortCode: "rlcode22345",
      installerPlatform: "windows",
    });
    const childRow = makeChildKeyRow({ installerPlatform: "windows" });

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([shortLinkRow]),
        }),
      }),
    } as any);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: KEY_ID }]),
        }),
      }),
    } as any);
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([childRow]),
      }),
    } as any);

    const { rateLimiter } = await import("../services/rate-limit");
    vi.mocked(rateLimiter).mockResolvedValue({
      allowed: true,
      remaining: 29,
      resetAt: new Date(Date.now() + 3_600_000),
    });

    await app.request("/s/rlcode22345", {
      headers: { "cf-connecting-ip": "198.51.100.5" },
    });

    // First rateLimiter call must be the per-short-code 30/3600 bucket.
    const calls = vi.mocked(rateLimiter).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const [, key, limit, windowSeconds] = calls[0] as [
      unknown,
      string,
      number,
      number,
    ];
    expect(key).toContain("rlcode22345");
    expect(limit).toBe(30);
    expect(windowSeconds).toBe(3600);
  });

  it("returns 503 when redis is unavailable for the per-short-code cap (fail closed)", async () => {
    const shortLinkRow = makeKeyRow({
      shortCode: "rlcode32345",
      installerPlatform: "windows",
    });

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([shortLinkRow]),
        }),
      }),
    } as any);

    mockGetRedis.mockReturnValueOnce(null as any);

    const res = await app.request("/s/rlcode32345");
    expect(res.status).toBe(503);
    // No atomic claim, no child key insert.
    expect(db.update).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });
});

// ============================================================
// GET /public-download/:platform — RLS scoping regression test
// ============================================================

describe("GET /public-download/:platform", () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(MsiSigningService.fromEnv).mockReturnValue(null);
    issueDownloadHandleMock.mockResolvedValue(`dlh_${"1".repeat(32)}`);
    consumeDownloadHandleMock.mockResolvedValue("a".repeat(64));
    process.env.PUBLIC_API_URL = "https://api.example.com";
    app = new Hono();
    app.route("/enrollment-keys", publicEnrollmentRoutes);
  });

  it("does not bump child key usage_count on download — leaves the slot for the agent enroll call", async () => {
    // Regression test for the root cause of the MSI "401 Invalid or
    // expired enrollment key" bug. Previously serveInstaller ran
    // `UPDATE enrollment_keys SET usage_count = usage_count + 1 WHERE
    // id = :keyRow.id` right after a successful build. Combined with
    // max_usage = 1 on single-use child keys (short-link downloads and
    // single-count installer links), this burned the enrollment slot
    // at *download* time: by the time the agent POSTed to
    // /agents/enroll, the child row already had usage_count >=
    // max_usage, the enroll endpoint's `usage_count < max_usage`
    // filter rejected the row, and the agent saw the deliberately-opaque
    // "Invalid or expired enrollment key" 401. The enroll endpoint
    // itself owns the slot-consuming UPDATE under a TOCTOU-safe
    // `UPDATE ... WHERE usage_count < max_usage`, so downloads must
    // NOT bump usage_count. max_usage is "max successful enrollments,"
    // not "max downloads."
    const row = makeKeyRow({
      shortCode: "pubcode1234",
      installerPlatform: "windows",
      maxUsage: 1,
      usageCount: 0,
    });

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([row]),
        }),
      }),
    } as any);

    // Fail loudly if anything inside the download path touches
    // db.update — the whole point of the fix is that the download path
    // is now read-only against the enrollment_keys row.
    vi.mocked(db.update).mockImplementation(() => {
      throw new Error(
        "db.update called on public-download — regression of the usage_count-burn bug",
      );
    });

    // serveInstaller (Windows) now calls issueBootstrapTokenForKey
    const issueSpy = vi
      .spyOn(installerBootstrapTokenIssuance, "issueBootstrapTokenForKey")
      .mockResolvedValueOnce({
        id: "btok-1",
        token: "ABC1234567",
        expiresAt: new Date(Date.now() + 3_600_000),
        parentKeyName: "Test Key",
      });

    const res = await app.request(
      `/enrollment-keys/public-download/windows?h=dlh_${"1".repeat(32)}`,
    );

    expect(res.status).toBe(200);
    expect(db.update).not.toHaveBeenCalled();

    issueSpy.mockRestore();
  });

  it("public windows download serves a static MSI named with the bootstrap token", async () => {
    // Verifies that the public download path uses the bootstrap-token flow:
    // issueBootstrapTokenForKey → fetchRegularMsi → serveWindowsBootstrapMsi
    // with the token embedded in the Content-Disposition filename.
    const row = makeKeyRow({
      shortCode: "pubcode1234",
      installerPlatform: "windows",
      maxUsage: 1,
      usageCount: 0,
    });

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([row]),
        }),
      }),
    } as any);

    const issueSpy = vi
      .spyOn(installerBootstrapTokenIssuance, "issueBootstrapTokenForKey")
      .mockResolvedValueOnce({
        id: "btok-1",
        token: "ABCDE12345",
        expiresAt: new Date(Date.now() + 3_600_000),
        parentKeyName: "Test Key",
      });

    const res = await app.request(
      `/enrollment-keys/public-download/windows?h=dlh_${"1".repeat(32)}`,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(res.headers.get("Content-Disposition")).toMatch(
      /^attachment; filename="Bl4ck Agent \(ABCDE12345@api\.example\.com\)\.msi"$/,
    );
    // No db.update — download does not consume enrollment slots
    expect(db.update).not.toHaveBeenCalled();

    // BREEZE-5: the anonymous public-download audit row must use the
    // anonymous-actor UUID sentinel, not the literal string "public" —
    // audit_logs.actor_id is `uuid NOT NULL`, so "public" made every
    // anonymous-download audit insert fail with pg 22P02 (invalid uuid).
    expect(vi.mocked(createAuditLogAsync)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "enrollment_key.public_download",
        actorId: "00000000-0000-0000-0000-000000000000",
      }),
    );

    issueSpy.mockRestore();
  });

  it("public windows download encodes a nonstandard port as host_PORT in the filename (#2341)", async () => {
    // `:` is illegal in Windows filenames — the browser rewrites it at save
    // time and the agent-side parser never matches, so the device installs
    // unenrolled with no visible error. The port must ride as `_PORT`.
    process.env.PUBLIC_API_URL = "https://self-hosted.example.com:8443";
    const row = makeKeyRow({
      shortCode: "pubcode1234",
      installerPlatform: "windows",
      maxUsage: 1,
      usageCount: 0,
    });

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([row]),
        }),
      }),
    } as any);

    const issueSpy = vi
      .spyOn(installerBootstrapTokenIssuance, "issueBootstrapTokenForKey")
      .mockResolvedValueOnce({
        id: "btok-1",
        token: "ABCDE12345",
        expiresAt: new Date(Date.now() + 3_600_000),
        parentKeyName: "Test Key",
      });

    const res = await app.request(
      `/enrollment-keys/public-download/windows?h=dlh_${"1".repeat(32)}`,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toBe(
      'attachment; filename="Bl4ck Agent (ABCDE12345@self-hosted.example.com_8443).msi"',
    );

    issueSpy.mockRestore();
  });

  it("public windows download returns 400 for a non-https server URL without burning a token (#2341)", async () => {
    // The agent always redeems the filename token over https, so an
    // http-only server can never enroll through this path — fail the
    // download with the reason instead of serving a dead MSI.
    process.env.PUBLIC_API_URL = "http://self-hosted.example.com:8080";
    const row = makeKeyRow({
      shortCode: "pubcode1234",
      installerPlatform: "windows",
      maxUsage: 1,
      usageCount: 0,
    });

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([row]),
        }),
      }),
    } as any);

    const issueSpy = vi.spyOn(
      installerBootstrapTokenIssuance,
      "issueBootstrapTokenForKey",
    );

    const res = await app.request(
      `/enrollment-keys/public-download/windows?h=dlh_${"1".repeat(32)}`,
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/https/i);
    expect(issueSpy).not.toHaveBeenCalled();

    issueSpy.mockRestore();
  });

  it("returns 410 without issuing a bootstrap token when parent key is within the min-remaining window (#2775 fix-round-1)", async () => {
    // Public/unauthenticated path (shared serveInstaller helper). Before this
    // guard, a near-dead parent would still mint a bootstrap token — which,
    // post #2775 fix, gets a full independent TTL uncapped by the parent.
    // Must refuse outright, and must NOT leak parent-key name/id in the
    // public error response.
    const row = makeKeyRow({
      shortCode: "pubcode1234",
      installerPlatform: "windows",
      maxUsage: 1,
      usageCount: 0,
      expiresAt: new Date(Date.now() + 30_000),
    });

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([row]),
        }),
      }),
    } as any);

    const issueSpy = vi.spyOn(
      installerBootstrapTokenIssuance,
      "issueBootstrapTokenForKey",
    );

    const res = await app.request(
      `/enrollment-keys/public-download/windows?h=dlh_${"1".repeat(32)}`,
    );

    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.error).toMatch(/expiring too soon/i);
    expect(body.error).not.toMatch(/Test Key/);
    expect(issueSpy).not.toHaveBeenCalled();

    issueSpy.mockRestore();
  });

  it("rejects legacy raw token query downloads by default", async () => {
    const res = await app.request(
      `/enrollment-keys/public-download/windows?token=${"a".repeat(64)}`,
    );

    expect(res.status).toBe(400);
    expect(consumeDownloadHandleMock).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
  });

  it("rejects legacy raw token query downloads even behind the retired compatibility flag", async () => {
    process.env.PUBLIC_INSTALLER_ALLOW_LEGACY_TOKEN_QUERY = "true";

    const res = await app.request(
      `/enrollment-keys/public-download/windows?token=${"b".repeat(64)}`,
    );

    expect(res.status).toBe(400);
    expect(consumeDownloadHandleMock).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
    delete process.env.PUBLIC_INSTALLER_ALLOW_LEGACY_TOKEN_QUERY;
  });
});

// ============================================================
// H6: public installer rate limit — XFF spoofing + fail-closed
// ============================================================

describe("H6: public-installer rate limit hardening", () => {
  let app: Hono;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(MsiSigningService.fromEnv).mockReturnValue(null);
    consumeDownloadHandleMock.mockResolvedValue("a".repeat(64));
    process.env.PUBLIC_API_URL = "https://api.example.com";
    // Ensure getTrustedClientIp is in production-strict mode by default in
    // these tests so spoofed XFF is ignored.
    process.env.NODE_ENV = "production";
    process.env.TRUST_PROXY_HEADERS = "false";
    mockGetRedis.mockReturnValue({} as any);
    const { rateLimiter } = await import("../services/rate-limit");
    vi.mocked(rateLimiter).mockResolvedValue({
      allowed: true,
      remaining: 9,
      resetAt: new Date(Date.now() + 60_000),
    });

    app = new Hono();
    app.route("/enrollment-keys", publicEnrollmentRoutes);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  function mockKeyLookup() {
    const row = makeKeyRow({
      shortCode: "pubcode1234",
      installerPlatform: "windows",
      maxUsage: 1,
      usageCount: 0,
    });
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([row]),
        }),
      }),
    } as any);
  }

  it('ignores spoofed X-Forwarded-For — buckets share an "unknown" key', async () => {
    mockKeyLookup();
    const { rateLimiter } = await import("../services/rate-limit");

    await app.request(
      `/enrollment-keys/public-download/windows?h=dlh_${"1".repeat(32)}`,
      { headers: { "X-Forwarded-For": "1.2.3.4" } },
    );
    mockKeyLookup();
    await app.request(
      `/enrollment-keys/public-download/windows?h=dlh_${"1".repeat(32)}`,
      { headers: { "X-Forwarded-For": "5.6.7.8" } },
    );

    // Both requests must use the SAME per-IP bucket key — spoofed XFF must
    // NOT give the attacker a fresh limit per fake IP.
    const calls = vi.mocked(rateLimiter).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const ipKeys = calls
      .map((c) => c[1] as string)
      .filter((k) => k.startsWith("public-installer:"));
    expect(ipKeys.length).toBeGreaterThanOrEqual(2);
    const distinct = new Set(ipKeys);
    expect(distinct.size).toBe(1);
    // Confirm we did NOT key off the spoofed IP.
    for (const k of ipKeys) {
      expect(k).not.toContain("1.2.3.4");
      expect(k).not.toContain("5.6.7.8");
    }
  });

  it("returns 503 when getRedis() is null (fail closed, NOT 200)", async () => {
    mockKeyLookup();
    mockGetRedis.mockReturnValueOnce(null as any);

    const res = await app.request(
      `/enrollment-keys/public-download/windows?h=dlh_${"1".repeat(32)}`,
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/temporarily unavailable/i);
  });

  it("returns 503 when rateLimiter throws (fail closed, NOT 200)", async () => {
    mockKeyLookup();
    const { rateLimiter } = await import("../services/rate-limit");
    vi.mocked(rateLimiter).mockRejectedValueOnce(
      new Error("redis disconnected"),
    );

    const res = await app.request(
      `/enrollment-keys/public-download/windows?h=dlh_${"1".repeat(32)}`,
    );
    expect(res.status).toBe(503);
  });

  it("returns 429 when over the rate limit", async () => {
    mockKeyLookup();
    const { rateLimiter } = await import("../services/rate-limit");
    vi.mocked(rateLimiter).mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: new Date(Date.now() + 60_000),
    });

    const res = await app.request(
      `/enrollment-keys/public-download/windows?h=dlh_${"1".repeat(32)}`,
    );
    expect(res.status).toBe(429);
  });

  // Task 32: per-(enrollment-key id) signing cap on the public-download path,
  // so IP rotation cannot exhaust the signing-service budget for a single key.
  it("checks a per-enrollment-key cap (30/hr) in addition to per-IP", async () => {
    mockKeyLookup();
    const { rateLimiter } = await import("../services/rate-limit");

    await app.request(
      `/enrollment-keys/public-download/windows?h=dlh_${"1".repeat(32)}`,
    );

    // Expect two distinct rateLimiter calls: one per-IP (10/60), one per-key
    // (30/3600). Order isn't load-bearing — just that both buckets are hit.
    const calls = vi.mocked(rateLimiter).mock.calls.map((c) => ({
      key: c[1] as string,
      limit: c[2] as number,
      window: c[3] as number,
    }));
    const ipCall = calls.find(
      (c) => c.limit === 10 && c.window === 60,
    );
    const keyCall = calls.find(
      (c) => c.limit === 30 && c.window === 3600,
    );
    expect(ipCall).toBeDefined();
    expect(keyCall).toBeDefined();
    // The per-key bucket must NOT be IP-derived (so IP rotation doesn't
    // create fresh buckets).
    expect(keyCall!.key).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });

  it("returns 429 when per-enrollment-key cap is reached even on a fresh IP", async () => {
    mockKeyLookup();
    const { rateLimiter } = await import("../services/rate-limit");
    // Per-IP allowed, per-key blocked.
    vi.mocked(rateLimiter)
      .mockResolvedValueOnce({
        allowed: true,
        remaining: 9,
        resetAt: new Date(Date.now() + 60_000),
      })
      .mockResolvedValueOnce({
        allowed: false,
        remaining: 0,
        resetAt: new Date(Date.now() + 3_600_000),
      });

    const res = await app.request(
      `/enrollment-keys/public-download/windows?h=dlh_${"1".repeat(32)}`,
      // Spoofed IP irrelevant — production-strict mode ignores XFF.
      { headers: { "X-Forwarded-For": "203.0.113.42" } },
    );
    expect(res.status).toBe(429);
  });
});

// ============================================================
// POST /:id/bootstrap-token
// ============================================================

describe("POST /:id/bootstrap-token", () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PUBLIC_API_URL = "https://api.example.com";
    app = new Hono();
    app.route("/enrollment-keys", enrollmentKeyRoutes);
  });

  it("issues a bootstrap token for a valid parent key", async () => {
    const parent = makeKeyRow();

    // select x2: route's access-control lookup + helper's business-rule lookup
    const parentSelectMock = {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([parent]),
        }),
      }),
    } as any;
    vi.mocked(db.select)
      .mockReturnValueOnce(parentSelectMock)
      .mockReturnValueOnce(parentSelectMock);

    // insert: create bootstrap token row — helper now uses .returning() to get the row id
    vi.mocked(db.insert).mockReturnValueOnce({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "token-row-uuid-1" }]),
      }),
    } as any);

    const res = await app.request(
      `/enrollment-keys/${KEY_ID}/bootstrap-token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxUsage: 1 }),
      },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toMatch(/^[A-Z0-9]{10}$/);
    expect(body.expiresAt).toBeTypeOf("string");
    expect(body.maxUsage).toBe(1);
  });

  it("rejects unknown parent key with 404", async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as any);

    const missingId = randomUUID();
    const res = await app.request(
      `/enrollment-keys/${missingId}/bootstrap-token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxUsage: 1 }),
      },
    );

    expect(res.status).toBe(404);
  });

  it("rejects when caller has no org access (403)", async () => {
    // Override authMiddleware to return a scope where canAccessOrg returns false
    const { authMiddleware: mockAuth } = await import("../middleware/auth");
    vi.mocked(mockAuth).mockImplementationOnce((c: any, next: any) => {
      c.set("auth", {
        scope: "partner",
        orgId: null,
        user: { id: "user-partner", email: "partner@example.com" },
        canAccessOrg: () => false,
        accessibleOrgIds: [],
      });
      return next();
    });

    const restrictedApp = new Hono();
    restrictedApp.route("/enrollment-keys", enrollmentKeyRoutes);

    const parent = makeKeyRow();

    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([parent]),
        }),
      }),
    } as any);

    const res = await restrictedApp.request(
      `/enrollment-keys/${KEY_ID}/bootstrap-token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxUsage: 1 }),
      },
    );

    expect(res.status).toBe(403);
  });

  it("rejects expired parent key with 410", async () => {
    const expiredParent = makeKeyRow({
      expiresAt: new Date(Date.now() - 10_000), // past
    });

    // select x2: route's access-control lookup + helper's business-rule lookup
    const expiredSelectMock = {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([expiredParent]),
        }),
      }),
    } as any;
    vi.mocked(db.select)
      .mockReturnValueOnce(expiredSelectMock)
      .mockReturnValueOnce(expiredSelectMock);

    const res = await app.request(
      `/enrollment-keys/${KEY_ID}/bootstrap-token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxUsage: 1 }),
      },
    );

    expect(res.status).toBe(410);
  });

  it("refuses to issue a bootstrap token when parent key is within 60s of expiry (#2775 fix-round-1)", async () => {
    // Parent with only 30s of life left. Before this guard, the route called
    // issueBootstrapTokenForKey directly, which (post #2775 fix) mints a
    // fresh, independent TTL uncapped by the parent — so a near-dead parent
    // would produce a token that outlives it. Refuse outright instead,
    // matching the /installer-link and /installer/:platform guards.
    const parent = makeKeyRow({
      expiresAt: new Date(Date.now() + 30_000),
    });

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([parent]),
        }),
      }),
    } as any);

    const insertValues = vi.fn();
    vi.mocked(db.insert).mockReturnValue({ values: insertValues } as any);

    const res = await app.request(
      `/enrollment-keys/${KEY_ID}/bootstrap-token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxUsage: 1 }),
      },
    );

    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.error).toContain("expires too soon");
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("honours ttlMinutes on the bootstrap-token route (#2775)", async () => {
    const parent = makeKeyRow();
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([parent]),
        }),
      }),
    } as any);

    const issueSpy = vi
      .spyOn(installerBootstrapTokenIssuance, "issueBootstrapTokenForKey")
      .mockResolvedValue({
        id: "token-row-uuid-2",
        token: "ABCDE12345",
        expiresAt: new Date(Date.now() + 129_600 * 60 * 1000),
        parentKeyName: "Test Key",
      } as any);

    const res = await app.request(
      `/enrollment-keys/${KEY_ID}/bootstrap-token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxUsage: 3, ttlMinutes: 129_600 }),
      },
    );

    expect(res.status).toBe(200);
    expect(issueSpy).toHaveBeenCalledWith(
      expect.objectContaining({ ttlMinutes: 129_600 }),
    );

    issueSpy.mockRestore();
  });

  it("rejects ttlMinutes above the cap on the bootstrap-token route (#2775)", async () => {
    const res = await app.request(
      `/enrollment-keys/${KEY_ID}/bootstrap-token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ttlMinutes: 525_601 }),
      },
    );

    expect(res.status).toBe(400);
  });

  // #2776 task 3.4 — a value the global schema max would allow (well under
  // 525_600) can still exceed a lower PARTNER cap, which only the DB-backed
  // assertTtlWithinCap gate (not the static zod schema) can enforce.
  it("rejects a ttlMinutes above the partner cap on the bootstrap-token route (#2776)", async () => {
    mockEnrollmentDefaults({ maxTtlMinutes: 1440 });
    const parent = makeKeyRow();
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([parent]),
        }),
      }),
    } as any);

    const insertValues = vi.fn();
    vi.mocked(db.insert).mockReturnValue({ values: insertValues } as any);

    const res = await app.request(
      `/enrollment-keys/${KEY_ID}/bootstrap-token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxUsage: 1, ttlMinutes: 43200 }),
      },
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("1440");
    expect(assertTtlWithinCapMock).toHaveBeenCalledWith(ORG_ID, 43200);
  });

  it("allows a ttlMinutes at exactly the partner cap on the bootstrap-token route (#2776)", async () => {
    mockEnrollmentDefaults({ maxTtlMinutes: 1440 });
    const parent = makeKeyRow();
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([parent]),
        }),
      }),
    } as any);

    vi.mocked(db.insert).mockReturnValueOnce({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "token-row-uuid-3" }]),
      }),
    } as any);

    const res = await app.request(
      `/enrollment-keys/${KEY_ID}/bootstrap-token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxUsage: 1, ttlMinutes: 1440 }),
      },
    );

    expect(res.status).toBe(200);
  });
});

// ============================================================
// POST / - siteId ownership validation
// ============================================================

describe("POST / - siteId ownership validation", () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PUBLIC_API_URL = "https://api.example.com";
    app = new Hono();
    app.route("/enrollment-keys", enrollmentKeyRoutes);
  });

  it("rejects siteId that does not belong to the target org", async () => {
    const orgId = randomUUID();
    const siteId = randomUUID();

    // select: site lookup returns empty (site not found in org)
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]), // not found
        }),
      }),
    } as any);

    const res = await app.request("/enrollment-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orgId,
        name: "Test Key",
        siteId,
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/siteId.*does not belong.*org/i);
    // insert should never be called when siteId validation fails
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("creates key with valid siteId", async () => {
    const orgId = randomUUID();
    const siteId = randomUUID();
    const keyRow = makeKeyRow({ orgId, siteId });

    // select: site lookup returns the site
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ id: siteId }]),
        }),
      }),
    } as any);

    // insert: create enrollment key
    vi.mocked(db.insert).mockReturnValueOnce({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([keyRow]),
      }),
    } as any);

    const res = await app.request("/enrollment-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orgId,
        name: "Test Key",
        siteId,
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.siteId).toBe(siteId);
  });

  it("creates key without siteId (null is valid)", async () => {
    const orgId = randomUUID();
    const keyRow = makeKeyRow({ orgId, siteId: null });

    // insert: create enrollment key with no siteId
    vi.mocked(db.insert).mockReturnValueOnce({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([keyRow]),
      }),
    } as any);

    const res = await app.request("/enrollment-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orgId,
        name: "Test Key",
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.siteId).toBeNull();
    // when no siteId is provided, site lookup should not be called
    expect(db.select).not.toHaveBeenCalled();
  });
});

// ============================================================
// POST / - partner cap enforcement (fix round 1, #2776 task 3.4)
//
// This route has TWO paths to an expiry — ttlMinutes and an explicit
// expiresAt (createEnrollmentKeySchema's refine guarantees only one is ever
// set) — and a parent enrollment key is itself an enrollment credential, so
// both paths must be gated. Capping only ttlMinutes would leave expiresAt as
// a wide-open bypass.
// ============================================================
describe("POST / - partner cap enforcement (fix round 1, #2776)", () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PUBLIC_API_URL = "https://api.example.com";
    app = new Hono();
    app.route("/enrollment-keys", enrollmentKeyRoutes);
  });

  it("rejects a ttlMinutes above the partner cap", async () => {
    mockEnrollmentDefaults({ maxTtlMinutes: 1440 });
    const orgId = randomUUID();
    const insertValues = vi.fn();
    vi.mocked(db.insert).mockReturnValue({ values: insertValues } as any);

    const res = await app.request("/enrollment-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orgId, name: "Test Key", ttlMinutes: 43200 }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("1440");
    expect(insertValues).not.toHaveBeenCalled();
    expect(assertTtlWithinCapMock).toHaveBeenCalledWith(orgId, 43200);
  });

  it("allows a ttlMinutes at exactly the partner cap", async () => {
    mockEnrollmentDefaults({ maxTtlMinutes: 1440 });
    const orgId = randomUUID();
    const keyRow = makeKeyRow({ orgId });
    vi.mocked(db.insert).mockReturnValueOnce({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([keyRow]),
      }),
    } as any);

    const res = await app.request("/enrollment-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orgId, name: "Test Key", ttlMinutes: 1440 }),
    });

    expect(res.status).toBe(201);
  });

  it("rejects an expiresAt whose implied duration exceeds the partner cap (the expiresAt bypass path)", async () => {
    mockEnrollmentDefaults({ maxTtlMinutes: 1440 });
    const orgId = randomUUID();
    const insertValues = vi.fn();
    vi.mocked(db.insert).mockReturnValue({ values: insertValues } as any);

    // 30 days out — far above a 1440-minute (24h) cap.
    const expiresAt = new Date(Date.now() + 43200 * 60 * 1000).toISOString();

    const res = await app.request("/enrollment-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orgId, name: "Test Key", expiresAt }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("1440");
    expect(insertValues).not.toHaveBeenCalled();
    // The route must derive an implied minutes value from expiresAt and
    // check IT against the cap — there is no ttlMinutes to check directly.
    const [, impliedMinutes] = assertTtlWithinCapMock.mock.calls[0]!;
    expect(impliedMinutes).toBeGreaterThan(43199);
    expect(impliedMinutes).toBeLessThanOrEqual(43201);
  });

  it("allows an expiresAt whose implied duration is comfortably under the partner cap", async () => {
    mockEnrollmentDefaults({ maxTtlMinutes: 1440 });
    const orgId = randomUUID();
    const keyRow = makeKeyRow({ orgId });
    vi.mocked(db.insert).mockReturnValueOnce({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([keyRow]),
      }),
    } as any);

    // 60 minutes out — comfortably under the 1440-minute cap.
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const res = await app.request("/enrollment-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orgId, name: "Test Key", expiresAt }),
    });

    expect(res.status).toBe(201);
  });

  it("passes undefined to the cap gate when neither ttlMinutes nor expiresAt is supplied (falls back to the deployment default, not a cap violation)", async () => {
    const orgId = randomUUID();
    const keyRow = makeKeyRow({ orgId });
    vi.mocked(db.insert).mockReturnValueOnce({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([keyRow]),
      }),
    } as any);

    const res = await app.request("/enrollment-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orgId, name: "Test Key" }),
    });

    expect(res.status).toBe(201);
    expect(assertTtlWithinCapMock).toHaveBeenCalledWith(orgId, undefined);
  });
});

// ============================================================
// BL4CK fork guarantee: installer enrollment keys are REUSABLE
//
// Upstream v0.102.0 mints child enrollment keys with `maxUsage: 1` on both
// fork-minted paths (redeemShortCode and the /s/:code redemption). The fork
// deliberately does NOT take that — it uses CHILD_ENROLLMENT_KEY_MAX_USAGE,
// which defaults to null, and routes/agents/enrollment.ts treats a null
// max_usage as UNLIMITED. These tests fail loudly if a future upstream merge
// reintroduces the single-use policy.
//
// The upstream partner TTL cap (clampTtlToCap / assertTtlWithinCap) is
// orthogonal: it bounds EXPIRY only and never reads or writes maxUsage. The
// third test pins that explicitly.
// ============================================================

describe("redeemShortCode — child key reusability (fork guarantee)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clampTtlToCapMock.mockImplementation(
      async (_orgId: string, ttlMinutes: number) => ttlMinutes,
    );
  });

  function mockRedeemDb(insertValues: ReturnType<typeof vi.fn>) {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi
            .fn()
            .mockResolvedValue([
              makeKeyRow({ shortCode: "invite0001", installerPlatform: "windows" }),
            ]),
        }),
      }),
    } as any);
    vi.mocked(db.insert).mockReturnValue({ values: insertValues } as any);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: KEY_ID }]),
        }),
      }),
    } as any);
  }

  it("inserts the child key with maxUsage: null (UNLIMITED), never 1", async () => {
    const insertValues = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([makeChildKeyRow({ installerPlatform: "windows" })]),
    });
    mockRedeemDb(insertValues);

    const result = await redeemShortCode("invite0001");

    expect(result).not.toBeNull();
    expect(insertValues).toHaveBeenCalledTimes(1);
    const insertedRow = insertValues.mock.calls[0]![0] as { maxUsage: number | null };
    expect(insertedRow.maxUsage).toBeNull();
    expect(insertedRow.maxUsage).not.toBe(1);
  });

  it("keeps maxUsage null even when the partner cap LOWERS the TTL", async () => {
    // A binding cap: 60 minutes against the 1440-minute server default.
    clampTtlToCapMock.mockImplementation(async () => 60);
    const insertValues = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([makeChildKeyRow({ installerPlatform: "windows" })]),
    });
    mockRedeemDb(insertValues);

    const before = Date.now();
    const result = await redeemShortCode("invite0001");
    const after = Date.now();

    expect(result).not.toBeNull();
    const insertedRow = insertValues.mock.calls[0]![0] as {
      maxUsage: number | null;
      expiresAt: Date;
    };
    // The cap DID bind — expiry was shortened to ~60 minutes...
    expect(insertedRow.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 59 * 60 * 1000);
    expect(insertedRow.expiresAt.getTime()).toBeLessThanOrEqual(after + 60 * 60 * 1000 + 5_000);
    // ...but reusability is untouched. TTL caps are an EXPIRY control only.
    expect(insertedRow.maxUsage).toBeNull();
  });
});
