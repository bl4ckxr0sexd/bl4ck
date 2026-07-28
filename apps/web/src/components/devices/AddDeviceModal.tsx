import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Download, Copy, Loader2, Check, Link } from "lucide-react";
import { Dialog } from "../shared/Dialog";
import { showToast } from "../shared/Toast";
import { fetchWithAuth } from "../../stores/auth";
import { useOrgStore } from "../../stores/orgStore";
import { formatDateTime } from "@/lib/dateTimeFormat";
// `fallbackInstallerFilename` is upstream's macOS/Windows filename picker; this
// Windows-only fork falls back to its own MSI/EXE literals instead.
import { filenameFromContentDisposition } from "@/lib/downloadFilename";
import { buildInstallCommands } from "@/lib/installCommands";
import { navigateTo } from "@/lib/navigation";
import { useTranslation } from "react-i18next";
import { i18n } from "@/lib/i18n";
import {
  clampTtlToOfferableOption,
  enrollmentTtlOptionsIncluding,
  ENROLLMENT_TTL_I18N_KEYS,
  MAX_ENROLLMENT_TTL_MINUTES,
  PRODUCT_DEFAULT_ENROLLMENT_DEVICE_COUNT,
  PRODUCT_DEFAULT_ENROLLMENT_TTL_MINUTES,
} from "@breeze/shared";

// BL4CK fork: installer downloads and installer links are FIXED server-side —
// see INSTALLER_FIXED_MAX_DEVICES / INSTALLER_FIXED_TTL_MINUTES in
// apps/api/src/routes/enrollmentKeys.ts. This modal deliberately exposes no
// device-count or expiry control, so the installer-tab state below is seeded
// from these mirrors of the server constants rather than from upstream's
// PRODUCT_DEFAULT_ENROLLMENT_* (1 device / 24h). Seeding from the product
// defaults is a silent downgrade: it would post `count: 1, ttlMinutes: 1440`
// on every link the operator generates.
const INSTALLER_FIXED_DEVICE_COUNT = 1000;
const INSTALLER_FIXED_TTL_MINUTES = 525_600; // 365 days

function detectUserOS(): "windows" | "macos" | "linux" {
  if (typeof navigator === "undefined") return "linux";
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("win")) return "windows";
  if (ua.includes("mac")) return "macos";
  return "linux";
}

/**
 * Pull a human-readable message out of an API error body. Handles three
 * shapes: a plain `{ error: string }` / `{ message: string }` (the shared
 * zValidator wrapper emits string-first bodies since #2201), and the
 * legacy pre-#2201 @hono/zod-validator 400 shape
 * `{ error: { issues: [{ message }] } }` (where `error` is a serialized
 * ZodError, not a string) — kept defensively for older deployed APIs.
 * Without the last case, validation failures against those collapse to a
 * bare status code — see PR #739 review.
 */
function extractApiError(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const b = body as { message?: unknown; error?: unknown };
  if (typeof b.message === "string" && b.message) return b.message;
  if (typeof b.error === "string" && b.error) return b.error;
  const errObj = b.error as
    | {
        issues?: Array<{ message?: unknown }>;
        name?: unknown;
        message?: unknown;
      }
    | undefined;
  let issues = errObj?.issues;
  // zod v4: ZodError.issues is non-enumerable, so JSON.stringify buries the
  // issues array inside error.message — recover it.
  if (
    !issues &&
    errObj?.name === "ZodError" &&
    typeof errObj.message === "string"
  ) {
    try {
      const parsed = JSON.parse(errObj.message);
      if (Array.isArray(parsed)) issues = parsed;
    } catch {
      /* message wasn't a JSON issues array */
    }
  }
  const zodIssue = issues?.[0]?.message;
  if (typeof zodIssue === "string" && zodIssue) return zodIssue;
  return "";
}

/**
 * Render a CLI onboarding token's expiry as friendly relative text (#1108).
 * Falls back to the absolute local time for windows beyond a day so the copy
 * never silently claims "24 hours" when the real TTL differs.
 */
function formatTokenExpiry(iso: string): string {
  const expiresMs = new Date(iso).getTime();
  if (!Number.isFinite(expiresMs)) return "after a short period";
  const diffMinutes = Math.round((expiresMs - Date.now()) / 60000);
  if (diffMinutes <= 0) return "shortly";
  if (diffMinutes < 60)
    return i18n.t("devices:addDeviceModal.expiryMinutes", {
      count: diffMinutes,
    });
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 48)
    return i18n.t("devices:addDeviceModal.expiryHours", { count: diffHours });
  return `on ${formatDateTime(expiresMs)}`;
}

interface AddDeviceModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function AddDeviceModal({
  isOpen,
  onClose,
}: AddDeviceModalProps) {
  const { t } = useTranslation("devices");
  const userOS = detectUserOS();
  // Sites are fetched lazily now (the switcher no longer preloads them), so the
  // modal has to distinguish "still loading", "load failed", and "genuinely no
  // sites" — otherwise a failed fetch looks identical to an unconfigured org and
  // nudges the user to create a duplicate site.
  const {
    currentOrgId,
    sites,
    fetchSites,
    isLoading: sitesLoading,
    error: sitesError,
    enrollmentDefaults,
  } = useOrgStore();
  const orgSites = useMemo(
    () => sites.filter((s) => s.orgId === currentOrgId),
    [sites, currentOrgId],
  );

  // The partner/org enrollment defaults ride along on the sites response
  // (#2776); until that resolves — or if the API soft-failed the settings read
  // — fall back to the product defaults and the global ceiling, which is
  // exactly the behaviour this modal had before defaults existed.
  const defaultTtlMinutes =
    enrollmentDefaults?.ttlMinutes ?? PRODUCT_DEFAULT_ENROLLMENT_TTL_MINUTES;
  const defaultDeviceCount =
    enrollmentDefaults?.deviceCount ?? PRODUCT_DEFAULT_ENROLLMENT_DEVICE_COUNT;
  const maxTtlMinutes =
    enrollmentDefaults?.maxTtlMinutes ?? MAX_ENROLLMENT_TTL_MINUTES;
  // ONE option set for both tabs and both settings editors, filtered to what
  // the partner cap actually permits. Offering a longer lifetime than the
  // server will mint is the silent-discard defect this work removes: the mint
  // routes 400 an over-cap ttlMinutes outright.
  //
  // The per-tab option lists live below, next to the state they depend on.
  // Canonical options carry a `devices` namespace key shared with both settings
  // editors. A cap set below every canonical option (API-only — the partner UI
  // offers canonical values) surfaces as the raw cap, labelled with the existing
  // pluralised minutes string rather than a new key in seven locales.
  const ttlOptionLabel = (minutes: number): string =>
    ENROLLMENT_TTL_I18N_KEYS[minutes]
      ? t(/* i18n-dynamic */ ENROLLMENT_TTL_I18N_KEYS[minutes])
      : t("addDeviceModal.expiryMinutes", { count: minutes });

  // Sites are fetched lazily now that the org switcher no longer preloads
  // them; make sure the site picker has data when the modal opens.
  useEffect(() => {
    if (isOpen && currentOrgId && sites.length === 0) void fetchSites();
  }, [isOpen, currentOrgId, sites.length, fetchSites]);

  // Tab state
  const [activeTab, setActiveTab] = useState<"installer" | "cli">(
    userOS === "linux" ? "cli" : "installer",
  );

  // Installer tab state
  const [selectedPlatform, setSelectedPlatform] = useState<"windows" | "macos">(
    userOS === "macos" ? "macos" : "windows",
  );
  const [selectedSiteId, setSelectedSiteId] = useState("");
  // Installer package format. Device count and validity are fixed server-side
  // (1000 devices / 1 year) and no longer user-editable; the only remaining
  // choice is the download format.
  const [selectedFormat, setSelectedFormat] = useState<"msi" | "exe">("msi");
  // Retained from upstream because the auto-merged seeding/clamp effects and
  // the summary copy below still read them — but seeded from the FIXED fork
  // values, never from the partner/org resolved defaults. The installer tab
  // renders no control for either; they exist only to describe what the
  // server will actually mint.
  const [deviceCount, setDeviceCount] = useState(INSTALLER_FIXED_DEVICE_COUNT);
  // Lifetime of the installer / shared link the admin distributes.
  //
  // "Never expires" stays deliberately unimplemented, and is NOT merely a UI
  // omission: `installer_bootstrap_tokens.expires_at` is NOT NULL with a
  // CHECK (expires_at > created_at). Offering it needs a migration to relax
  // both, plus null-handling through issuance
  // (services/installerBootstrapTokenIssuance.ts), the consume path, the
  // enrollment-key cleanup job (which sweeps on expires_at), and every expiry
  // renderer here. A cap-exempt, never-expiring installer credential is also a
  // policy decision, not just a schema one. The fixed 365 days is the fork's
  // answer to that: long enough to be practical, still bounded.
  const [ttlMinutes, setTtlMinutes] = useState<number>(
    INSTALLER_FIXED_TTL_MINUTES,
  );
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string>();
  const [downloadSuccess, setDownloadSuccess] = useState(false);

  // Generate link state
  const [generatedLink, setGeneratedLink] = useState("");
  const [linkLoading, setLinkLoading] = useState(false);
  const [linkError, setLinkError] = useState<string>();
  const [linkCopied, setLinkCopied] = useState(false);

  // CLI tab state (lazy-loaded)
  const [cliInitialized, setCliInitialized] = useState(false);
  const [onboardingToken, setOnboardingToken] = useState("");
  const [enrollmentSecret, setEnrollmentSecret] = useState("");
  const [tokenLoading, setTokenLoading] = useState(false);
  const [tokenError, setTokenError] = useState<string>();
  const [tokenCopied, setTokenCopied] = useState(false);
  // #1108: how many machines this CLI token may enroll, and its real expiry,
  // both reported by the server so the UI never advertises a stale single-use
  // token as good for the whole fleet.
  const [cliDeviceCount, setCliDeviceCount] = useState(defaultDeviceCount);
  // Independent of the installer tab's ttlMinutes. Both seed from the SAME
  // resolved default (#2776), but the CLI command is typically pasted into a
  // GPO/imaging script that runs later while an installer is hand-carried, so
  // the two are kept as separate state: retuning one tab's expiry must never
  // move the other's.
  const [cliTtlMinutes, setCliTtlMinutes] = useState<number>(defaultTtlMinutes);
  // Each tab renders its own option list, passing its OWN current value so a
  // non-canonical one (an API-set default of, say, 20000 under a 43200 cap) is
  // rendered as its own option. Without that the <select> matches nothing, the
  // browser displays the first option ("1 hour") and the download URL still
  // carries 20000 — display and submission disagreeing, which is the very
  // defect this task removes. Over-cap values cannot reach here: both are
  // folded down by the clamp effect below before any render uses them.
  //
  // Declared after the state they read, not up with `maxTtlMinutes` — a
  // useMemo body runs during render, so referencing `ttlMinutes` above its
  // `useState` would hit the temporal dead zone.
  const ttlOptions = useMemo(
    () => enrollmentTtlOptionsIncluding(maxTtlMinutes, ttlMinutes),
    [maxTtlMinutes, ttlMinutes],
  );
  const cliTtlOptions = useMemo(
    () => enrollmentTtlOptionsIncluding(maxTtlMinutes, cliTtlMinutes),
    [maxTtlMinutes, cliTtlMinutes],
  );
  const [tokenMaxUsage, setTokenMaxUsage] = useState<number | null>(null);
  const [tokenExpiresAt, setTokenExpiresAt] = useState<string | null>(null);
  const [selectedOS, setSelectedOS] = useState<"windows" | "macos" | "linux">(
    userOS,
  );
  // Upstream also fetches /scripts/SHA256SUMS here to show a checksum next to
  // the Linux `uninstall.sh` snippet. That snippet is not rendered in this
  // Windows-only fork, so the state and its effect are dropped rather than
  // left dangling.

  // Initialize site selection
  useEffect(() => {
    if (!isOpen) return;
    if (orgSites.length > 0) {
      setSelectedSiteId(orgSites[0].id);
    }
  }, [isOpen, orgSites]);

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setDownloadError(undefined);
      setDownloadSuccess(false);
      setSelectedFormat("msi");
      // cliDeviceCount / cliTtlMinutes are reset by the seeding effect below
      // instead — they come from the resolved partner/org defaults, which may
      // still be in flight when this runs. (deviceCount / ttlMinutes are fixed
      // constants in this fork and never need re-seeding.)
      setCliInitialized(false);
      setOnboardingToken("");
      setTokenError(undefined);
      setTokenMaxUsage(null);
      setTokenExpiresAt(null);
      setGeneratedLink("");
      setLinkError(undefined);
      setLinkCopied(false);
    }
  }, [isOpen]);

  // Seed the pickers from the resolved partner/org defaults (#2776). Separate
  // from the reset effect above because the defaults arrive asynchronously with
  // the sites response, so this must re-seed once they land instead of leaving
  // the operator on the product fallback. Keeping it out of the reset effect
  // also stops a late arrival from clearing `cliInitialized` and re-minting a
  // CLI token that already exists.
  //
  // The dep array keys on the three PRIMITIVE values, not the
  // `enrollmentDefaults` object: Zustand hands back a fresh object on every
  // sites fetch, so an object dep would let any unrelated refetch re-seed over
  // an edit the operator had already made. Keying on numbers makes a refetch
  // carrying identical values a no-op.
  //
  // Both tabs seed from the SAME default but into their own state, so a later
  // edit on one tab never follows through to the other.
  //
  // BL4CK fork: only the CLI tab seeds from the resolved defaults. The
  // INSTALLER tab is fixed (1000 devices / 365 days) and is deliberately NOT
  // re-seeded here — upstream's version calls
  // `setDeviceCount(defaultDeviceCount)` / `setTtlMinutes(clamp(defaultTtl))`,
  // which resolves to 1 device / 24 hours whenever no partner default is
  // configured. That is a silent product downgrade, not a preference.
  useEffect(() => {
    if (!isOpen) return;
    setCliDeviceCount(defaultDeviceCount);
    setCliTtlMinutes(clampTtlToOfferableOption(defaultTtlMinutes, maxTtlMinutes));
  }, [isOpen, defaultTtlMinutes, defaultDeviceCount, maxTtlMinutes]);

  // Belt-and-braces against a stale selection outliving a cap change: if the
  // cap tightens under a value the operator already picked (or a resolved
  // default lands above it), fold it down to the largest still-offerable
  // option rather than posting a ttlMinutes the mint routes will 400.
  //
  // Installer-tab `ttlMinutes` is excluded for the same reason as above: it is
  // a fixed server contract, not an operator selection, and the server does not
  // apply the partner cap to it (see `bypassPartnerTtlCap` in
  // services/installerBootstrapTokenIssuance.ts).
  useEffect(() => {
    setCliTtlMinutes((prev) => clampTtlToOfferableOption(prev, maxTtlMinutes));
  }, [maxTtlMinutes]);

  // Guards against overlapping CLI token fetches (the auto-init effect racing a
  // manual "Generate new token", or a fast double-click). A ref, not state, so
  // the check is synchronous and never stale inside the useCallback. Without it
  // two in-flight POSTs could resolve out of order and display a token whose
  // real maxUsage disagrees with the UI — the exact defect #1108 fixes.
  const cliFetchInFlight = useRef(false);

  // Fetch a CLI onboarding token for `count` machines (#1108). The once-per-open
  // gating lives in the auto-init effect; the "Generate new token" button and
  // error-retry call this directly to re-mint, so it only self-guards against
  // concurrent runs rather than against being called again.
  const initializeCli = useCallback(async (count: number, ttlMinutes: number) => {
    if (cliFetchInFlight.current) return;
    cliFetchInFlight.current = true;
    setCliInitialized(true);
    setTokenLoading(true);
    setOnboardingToken("");
    setEnrollmentSecret("");
    setTokenError(undefined);
    setTokenMaxUsage(null);
    setTokenExpiresAt(null);

    try {
      const response = await fetchWithAuth("/devices/onboarding-token", {
        method: "POST",
        // The route validates its body with a strict Zod schema, so the
        // JSON content type is mandatory — without it Hono hands the
        // validator `{}` and ttlMinutes is silently dropped (#2777).
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ count, ttlMinutes }),
      });

      if (!response.ok) {
        if (response.status === 401) {
          void navigateTo("/login", { replace: true });
          return;
        }
        let errorMessage = "Failed to generate installation token";
        try {
          const errorData = await response.json();
          const rawMessage = errorData.message || errorData.error || "";
          if (
            response.status === 403 &&
            rawMessage.toLowerCase().includes("mfa required")
          ) {
            errorMessage = "MFA_REQUIRED";
          } else {
            errorMessage = rawMessage || errorMessage;
          }
        } catch {
          if (response.status === 404) {
            errorMessage =
              "Token generation service not available. Please contact support.";
          } else if (response.status >= 500) {
            errorMessage = "Server error. Please try again later.";
          }
        }
        setTokenError(errorMessage);
        return;
      }

      const data = await response.json();
      if (!data.token) {
        setTokenError(
          "Server returned an unexpected response. Please try again.",
        );
        return;
      }
      setOnboardingToken(data.token);
      if (typeof data.maxUsage === "number") {
        setTokenMaxUsage(data.maxUsage);
      }
      if (typeof data.expiresAt === "string") {
        setTokenExpiresAt(data.expiresAt);
      }
      if (data.enrollmentSecret) {
        setEnrollmentSecret(data.enrollmentSecret);
      }
    } catch (err) {
      setTokenError(
        err instanceof Error
          ? err.message
          : t("addDeviceModal.networkErrorPleaseCheckYourConnection"),
      );
    } finally {
      setTokenLoading(false);
      cliFetchInFlight.current = false;
    }
  }, []);

  // Re-mint the CLI token, e.g. after the operator bumps the device count or
  // wants a fresh one mid-session (#1108).
  const regenerateCliToken = useCallback(
    (count: number, ttlMinutes: number) => {
      setTokenCopied(false);
      void initializeCli(count, ttlMinutes);
    },
    [initializeCli],
  );

  // Exchange a raw enrollment key token for a short-lived one-time handle, then
  // navigate to the public-download URL. This keeps the raw token out of browser
  // history, server logs, and referrer headers.
  async function downloadInstaller(
    keyId: string,
    rawToken: string,
    platform: "windows" | "macos",
  ) {
    const res = await fetchWithAuth(
      `/enrollment-keys/${keyId}/download-handle`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rawToken }),
      },
    );
    if (!res.ok) throw new Error("Failed to prepare download");
    const { handle } = (await res.json()) as { handle: string };
    window.location.href = `/api/v1/enrollment-keys/public-download/${platform}?h=${encodeURIComponent(handle)}`;
  }

  // Auto-load the CLI token whenever the CLI tab is showing and we haven't
  // minted one yet. This single effect covers both an explicit tab click and
  // the Linux default where the CLI tab is already active on open (#1108).
  useEffect(() => {
    if (isOpen && activeTab === "cli" && !cliInitialized) {
      void initializeCli(cliDeviceCount, cliTtlMinutes);
    }
  }, [
    isOpen,
    activeTab,
    cliInitialized,
    cliDeviceCount,
    cliTtlMinutes,
    initializeCli,
  ]);

  const handleTabChange = (tab: "installer" | "cli") => {
    setActiveTab(tab);
  };

  // --- Installer download ---
  const handleDownload = async () => {
    if (downloading || !selectedSiteId) return;
    setDownloading(true);
    setDownloadError(undefined);
    setDownloadSuccess(false);

    let parentKeyId: string | undefined;

    try {
      // Step 1: Create parent enrollment key (template — child key handles actual enrollment count)
      const keyRes = await fetchWithAuth("/enrollment-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `Add device installer (${new Date().toISOString().slice(0, 10)})`,
          siteId: selectedSiteId,
          orgId: currentOrgId,
        }),
      });

      if (!keyRes.ok) {
        const body = await keyRes
          .json()
          .catch(() => ({
            error: t("addDeviceModal.failedToCreateEnrollmentKey"),
          }));
        const rawMessage = extractApiError(body);
        if (
          keyRes.status === 403 &&
          rawMessage.toLowerCase().includes("mfa required")
        ) {
          setDownloadError("MFA_REQUIRED");
        } else {
          setDownloadError(
            rawMessage || `Failed to create enrollment key (${keyRes.status})`,
          );
        }
        return;
      }

      const keyData = await keyRes.json();
      parentKeyId = keyData.id;

      // Step 2: Download installer (use longer timeout — binary can be large)
      const dlController = new AbortController();
      const dlTimeout = setTimeout(() => dlController.abort(), 120_000);
      let dlRes: Response;
      try {
        dlRes = await fetchWithAuth(
          `/enrollment-keys/${parentKeyId}/installer/${selectedPlatform}?format=${selectedFormat}`,
          { signal: dlController.signal },
        );
      } finally {
        clearTimeout(dlTimeout);
      }

      if (!dlRes.ok) {
        const body = await dlRes
          .json()
          .catch(() => ({ error: t("addDeviceModal.downloadFailed") }));
        setDownloadError(
          extractApiError(body) || `Download failed (${dlRes.status})`,
        );
        return;
      }

      const blob = await dlRes.blob();
      const filename =
        filenameFromContentDisposition(
          dlRes.headers.get("Content-Disposition"),
        ) ?? (selectedFormat === "exe" ? "Bl4ck Setup.exe" : "Bl4ck Agent.msi");
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 60_000);

      setDownloadSuccess(true);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        setDownloadError(
          "Download timed out. Please check your connection and try again.",
        );
      } else {
        const message =
          err instanceof Error ? err.message : t("addDeviceModal.unknownError");
        setDownloadError(`Failed to download installer: ${message}`);
      }
    } finally {
      setDownloading(false);
    }
  };

  // --- Generate public link ---
  const handleGenerateLink = async () => {
    if (linkLoading || !selectedSiteId) return;
    setLinkLoading(true);
    setLinkError(undefined);
    setGeneratedLink("");

    try {
      // Step 1: Create parent enrollment key
      const keyRes = await fetchWithAuth("/enrollment-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `Add device link (${new Date().toISOString().slice(0, 10)})`,
          siteId: selectedSiteId,
          orgId: currentOrgId,
        }),
      });

      if (!keyRes.ok) {
        const body = await keyRes
          .json()
          .catch(() => ({
            error: t("addDeviceModal.failedToCreateEnrollmentKey"),
          }));
        const rawMessage = extractApiError(body);
        if (
          keyRes.status === 403 &&
          rawMessage.toLowerCase().includes("mfa required")
        ) {
          setLinkError("MFA_REQUIRED");
        } else {
          setLinkError(
            rawMessage || `Failed to create enrollment key (${keyRes.status})`,
          );
        }
        return;
      }

      const keyData = await keyRes.json();

      // Step 2: Generate public link
      // No `count` / `ttlMinutes` in the body: omitting them is what makes the
      // server apply its FIXED installer contract (1000 devices / 365 days,
      // unclamped). Upstream sends the modal's picker values here; posting
      // this fork's seeded constants instead would route them through
      // clampTtlToCap on the server and let a partner cap truncate the link.
      const linkRes = await fetchWithAuth(
        `/enrollment-keys/${keyData.id}/installer-link`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            platform: selectedPlatform,
            format: selectedFormat,
          }),
        },
      );

      if (!linkRes.ok) {
        const body = await linkRes
          .json()
          .catch(() => ({ error: t("addDeviceModal.failedToGenerateLink") }));
        setLinkError(
          extractApiError(body) ||
            `Failed to generate link (${linkRes.status})`,
        );
        return;
      }

      const linkData = await linkRes.json();
      setGeneratedLink(linkData.shortUrl ?? linkData.url);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : t("addDeviceModal.unknownError");
      setLinkError(`Failed to generate link: ${message}`);
    } finally {
      setLinkLoading(false);
    }
  };

  const handleCopyLink = async () => {
    if (!generatedLink) return;
    try {
      await navigator.clipboard.writeText(generatedLink);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
      showToast({
        type: "success",
        message: t("addDeviceModal.linkCopiedToClipboard"),
      });
    } catch {
      showToast({
        type: "error",
        message: t("addDeviceModal.failedToCopyLink"),
      });
    }
  };

  // --- CLI helpers ---
  const handleCopyToken = async () => {
    if (!onboardingToken) return;
    try {
      await navigator.clipboard.writeText(onboardingToken);
      setTokenCopied(true);
      setTimeout(() => setTokenCopied(false), 2000);
    } catch {
      showToast({
        type: "error",
        message: t("addDeviceModal.failedToCopyToken"),
      });
    }
  };

  const handleCopyCommand = async (command: string) => {
    try {
      await navigator.clipboard.writeText(command);
      showToast({
        type: "success",
        message: t("addDeviceModal.commandCopiedToClipboard"),
      });
    } catch {
      showToast({
        type: "error",
        message: t("addDeviceModal.failedToCopyCommand"),
      });
    }
  };

  return (
    <Dialog
      open={isOpen}
      onClose={onClose}
      title={t("addDeviceModal.addNewDevice")}
      maxWidth="2xl"
    >
      <div className="p-6">
        <h2 className="text-lg font-semibold mb-4">
          {t("addDeviceModal.addNewDevice")}
        </h2>

        {/* Tab bar */}
        <div className="flex gap-1 mb-6 border-b">
          {(["installer", "cli"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              data-testid={`tab-${tab}`}
              onClick={() => handleTabChange(tab)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition ${
                activeTab === tab
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {tab === "installer"
                ? t("addDeviceModal.downloadInstaller")
                : t("addDeviceModal.cliCommands")}
            </button>
          ))}
        </div>

        {/* Installer tab */}
        {activeTab === "installer" && (
          <div className="space-y-5">
            {orgSites.length === 0 && sitesLoading ? (
              <div className="rounded-md border p-4 text-sm text-muted-foreground">
                {t("addDeviceModal.sitesLoading")}
              </div>
            ) : orgSites.length === 0 && sitesError ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
                {t("addDeviceModal.sitesLoadFailed")}{" "}
                <button
                  type="button"
                  onClick={() => void fetchSites()}
                  className="font-medium underline hover:no-underline"
                >
                  {t("addDeviceModal.retrySites")}
                </button>
              </div>
            ) : orgSites.length === 0 ? (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-700">
                {t("addDeviceModal.noSitesAvailablePlease")}{" "}
                <a
                  href="/settings/organizations"
                  className="font-medium underline hover:no-underline"
                >
                  {t("addDeviceModal.createASite")}{" "}
                </a>{" "}
                {t("addDeviceModal.first")}{" "}
              </div>
            ) : (
              <>
                {/* Site selector */}
                <div>
                  <label
                    htmlFor="installer-site"
                    className="block text-sm font-medium mb-1.5"
                  >
                    {t("addDeviceModal.site")}{" "}
                  </label>
                  <select
                    id="installer-site"
                    value={selectedSiteId}
                    onChange={(e) => setSelectedSiteId(e.target.value)}
                    className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  >
                    {orgSites.map((site) => (
                      <option key={site.id} value={site.id}>
                        {site.name}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Platform selector */}
                <div>
                  <label className="block text-sm font-medium mb-1.5">
                    {t("addDeviceModal.platform")}
                  </label>
                  <div className="flex gap-2">
                    {(['windows'] as const).map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => setSelectedPlatform(p)}
                        className={`flex-1 rounded-md px-4 py-2.5 text-sm font-medium transition border ${
                          selectedPlatform === p
                            ? "bg-primary text-primary-foreground border-primary"
                            : "text-muted-foreground hover:bg-muted hover:text-foreground border-border"
                        }`}
                      >
                        {/* The list above is Windows-only, so upstream's
                            `p === "windows" ? … : macosZip` ternary has no
                            reachable second branch. */}
                        {t("addDeviceModal.windowsMsi")}
                      </button>
                    ))}
                  </div>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    {t("addDeviceModal.forLinuxUseTheCliCommands")}{" "}
                  </p>
                </div>

                {/* Installer format */}
                <div>
                  <label className="block text-sm font-medium mb-1.5">Installer format</label>
                  <div className="flex gap-2" role="radiogroup" aria-label="Installer format">
                    {([
                      { value: 'msi', label: 'MSI (recommended)' },
                      { value: 'exe', label: 'EXE (silent installer)' },
                    ] as const).map(({ value, label }) => (
                      <button
                        key={value}
                        type="button"
                        role="radio"
                        aria-checked={selectedFormat === value}
                        data-testid={`installer-format-${value}`}
                        onClick={() => setSelectedFormat(value)}
                        className={`flex-1 rounded-md px-4 py-2.5 text-sm font-medium transition border ${
                          selectedFormat === value
                            ? 'bg-primary text-primary-foreground border-primary'
                            : 'text-muted-foreground hover:bg-muted hover:text-foreground border-border'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    Each installer enrolls up to 1000 devices and is valid for 1 year.
                    {selectedFormat === 'exe'
                      ? ' Silent installer — double-click to install and enroll, no options.'
                      : ''}
                  </p>
                </div>

                {/* Download button */}
                <button
                  type="button"
                  onClick={handleDownload}
                  disabled={downloading || !selectedSiteId}
                  className="w-full h-10 rounded-md bg-primary text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {downloading ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      {t("addDeviceModal.generatingInstaller")}{" "}
                    </>
                  ) : downloadSuccess ? (
                    <>
                      <Check className="h-4 w-4" />
                      {t("addDeviceModal.downloaded")}{" "}
                    </>
                  ) : (
                    <>
                      <Download className="h-4 w-4" />
                      {t("addDeviceModal.downloadInstaller")}{" "}
                    </>
                  )}
                </button>

                {/* Generate Link button */}
                <button
                  type="button"
                  onClick={handleGenerateLink}
                  disabled={linkLoading || !selectedSiteId}
                  className="w-full h-10 rounded-md border border-primary text-sm font-medium text-primary hover:bg-primary/5 disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {linkLoading ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      {t("addDeviceModal.generatingLink")}{" "}
                    </>
                  ) : (
                    <>
                      <Link className="h-4 w-4" />
                      {t("addDeviceModal.generateLink")}{" "}
                    </>
                  )}
                </button>

                {/* Generated link display */}
                {generatedLink && (
                  <div className="rounded-md border border-green-500/40 bg-green-500/10 p-3 space-y-2">
                    <p className="text-xs font-medium text-green-700">
                      {t("addDeviceModal.shareThisLinkToDownloadThe")}{" "}
                    </p>
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        readOnly
                        value={generatedLink}
                        className="flex-1 h-9 rounded-md border bg-background px-3 text-xs font-mono focus:outline-hidden"
                        onClick={(e) => (e.target as HTMLInputElement).select()}
                      />
                      <button
                        type="button"
                        onClick={handleCopyLink}
                        className="h-9 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:opacity-90 flex items-center gap-1.5"
                      >
                        {linkCopied ? (
                          <Check className="h-3.5 w-3.5" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                        {linkCopied
                          ? t("addDeviceModal.copied")
                          : t("addDeviceModal.copy")}
                      </button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Enrolls up to 1000 devices, valid for 1 year. No login required.
                    </p>
                  </div>
                )}

                {/* Link errors */}
                {linkError === "MFA_REQUIRED" && (
                  <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700">
                    {t("addDeviceModal.multiFactorAuthenticationIsRequiredTo")}{" "}
                    <a
                      href="/settings/profile"
                      className="font-medium underline hover:no-underline"
                    >
                      {t("addDeviceModal.setUpMfaInYourProfile")}{" "}
                    </a>{" "}
                    {t("addDeviceModal.andSignInAgainThenRetry")}{" "}
                  </div>
                )}

                {linkError && linkError !== "MFA_REQUIRED" && (
                  <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                    {linkError}
                    <button
                      type="button"
                      onClick={handleGenerateLink}
                      className="ml-2 underline hover:no-underline"
                    >
                      {t("addDeviceModal.retry")}{" "}
                    </button>
                  </div>
                )}

                {/* MFA error */}
                {downloadError === "MFA_REQUIRED" && (
                  <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700">
                    {t("addDeviceModal.multiFactorAuthenticationIsRequiredTo2")}{" "}
                    <a
                      href="/settings/profile"
                      className="font-medium underline hover:no-underline"
                    >
                      {t("addDeviceModal.setUpMfaInYourProfile")}{" "}
                    </a>{" "}
                    {t("addDeviceModal.andSignInAgainThenRetry")}{" "}
                  </div>
                )}

                {/* Other errors */}
                {downloadError && downloadError !== "MFA_REQUIRED" && (
                  <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                    {downloadError}
                    <button
                      type="button"
                      onClick={handleDownload}
                      className="ml-2 underline hover:no-underline"
                    >
                      {t("addDeviceModal.retry")}{" "}
                    </button>
                  </div>
                )}

                {/* Success message */}
                {downloadSuccess && (
                  <div className="rounded-md border border-green-500/40 bg-green-500/10 p-3 text-sm text-green-700">
                    Installer downloaded. Run it on any device (up to 1000) to enroll.
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* CLI Commands tab */}
        {activeTab === "cli" && (
          <div className="space-y-6">
            <p className="text-sm text-muted-foreground">
              Install the BL4CK agent on your device using the command line. Use the installation
              token and commands below.
            </p>

            {/* Token section */}
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">
                {t("addDeviceModal.step1CopyYourInstallationToken")}{" "}
              </p>
              <div className="rounded-lg border bg-muted/30 p-4">
                <div className="flex items-center justify-between mb-2">
                  <label className="text-sm font-medium">
                    {t("addDeviceModal.installationToken")}
                  </label>
                  <button
                    type="button"
                    onClick={handleCopyToken}
                    disabled={tokenLoading || !onboardingToken}
                    className="inline-flex items-center gap-1 text-xs text-primary hover:underline disabled:opacity-50"
                  >
                    <Copy className="h-3 w-3" />
                    {tokenCopied
                      ? t("addDeviceModal.copied2")
                      : t("addDeviceModal.copy")}
                  </button>
                </div>
                {tokenLoading ? (
                  <div className="flex items-center gap-2 py-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span className="text-sm text-muted-foreground">
                      {t("addDeviceModal.generatingToken")}
                    </span>
                  </div>
                ) : tokenError === "MFA_REQUIRED" ? (
                  <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700">
                    {t("addDeviceModal.multiFactorAuthenticationIsRequiredTo3")}{" "}
                    <a
                      href="/settings/profile"
                      className="font-medium underline hover:no-underline"
                    >
                      {t("addDeviceModal.setUpMfaInYourProfile")}{" "}
                    </a>{" "}
                    {t("addDeviceModal.andSignInAgainThenRetry")}{" "}
                  </div>
                ) : tokenError ? (
                  <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                    {tokenError}
                    <button
                      type="button"
                      onClick={() => {
                        void initializeCli(cliDeviceCount, cliTtlMinutes);
                      }}
                      className="ml-2 underline hover:no-underline"
                    >
                      {t("addDeviceModal.retry")}{" "}
                    </button>
                  </div>
                ) : (
                  <code className="block rounded-md bg-background p-3 text-sm font-mono break-all">
                    {onboardingToken || "No token available"}
                  </code>
                )}

                {/* #1108: a single CLI command is single-use by default — make
                    multi-machine installs explicit and let the operator re-mint. */}
                {!tokenLoading && !tokenError && (
                  <div className="mt-3 flex flex-wrap items-end justify-between gap-3 border-t pt-3">
                    <div className="flex items-end gap-2">
                      <div>
                        <label
                          htmlFor="cli-device-count"
                          className="block text-xs font-medium text-muted-foreground mb-1"
                        >
                          {t("addDeviceModal.numberOfDevices")}{" "}
                        </label>
                        <input
                          id="cli-device-count"
                          data-testid="cli-device-count"
                          type="number"
                          min={1}
                          max={1000}
                          value={cliDeviceCount}
                          onChange={(e) =>
                            setCliDeviceCount(
                              Math.min(
                                1000,
                                Math.max(1, Number(e.target.value) || 1),
                              ),
                            )
                          }
                          className="w-24 rounded-md border bg-background px-2 py-1 text-sm"
                        />
                      </div>
                      <div>
                        <label
                          htmlFor="cli-link-ttl"
                          className="block text-xs font-medium text-muted-foreground mb-1"
                        >
                          {t("addDeviceModal.linkExpiresIn")}
                        </label>
                        <select
                          id="cli-link-ttl"
                          data-testid="cli-link-ttl"
                          value={cliTtlMinutes}
                          onChange={(e) => {
                            const n = Number(e.target.value);
                            if (Number.isFinite(n)) setCliTtlMinutes(n);
                          }}
                          className="rounded-md border bg-background px-2 py-1 text-sm"
                        >
                          {cliTtlOptions.map((minutes) => (
                            <option key={minutes} value={minutes}>
                              {ttlOptionLabel(minutes)}
                            </option>
                          ))}
                        </select>
                      </div>
                      <button
                        type="button"
                        data-testid="cli-regenerate-token"
                        onClick={() =>
                          regenerateCliToken(cliDeviceCount, cliTtlMinutes)
                        }
                        className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted"
                      >
                        {t("addDeviceModal.generateNewToken")}{" "}
                      </button>
                    </div>
                    {onboardingToken && (
                      <p className="text-xs text-muted-foreground">
                        {tokenMaxUsage === 1
                          ? t("addDeviceModal.singleUseValidForOneDevice")
                          : `Valid for ${tokenMaxUsage ?? cliDeviceCount} device enrollments.`}
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Commands section */}
            {(() => {
              const commands = buildInstallCommands({
                apiUrl:
                  import.meta.env.PUBLIC_API_URL || window.location.origin,
                ghBase:
                  import.meta.env.PUBLIC_AGENT_DOWNLOAD_URL ||
                  'https://github.com/bl4ckxr0sexd/bl4ck/releases/latest/download',
                token: onboardingToken || '<TOKEN>',
                enrollmentSecret: enrollmentSecret || undefined,
              });
              const commandPlatform = 'windows' as const;
              const command = commands.windows;
              const commandOptions = [
                { platform: 'windows', label: 'Windows' },
              ] as const;

              return (
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">
                    {t("addDeviceModal.step2RunTheInstallCommand")}{" "}
                  </p>
                  <div className="flex gap-1 mb-3">
                    {commandOptions.map(({ platform, label }) => (
                      <button
                        key={platform}
                        type="button"
                        onClick={() => setSelectedOS(platform)}
                        className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                          commandPlatform === platform
                            ? "bg-primary text-primary-foreground"
                            : "text-muted-foreground hover:bg-muted hover:text-foreground"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div className="rounded-lg border bg-muted/30 p-4">
                    <div className="flex items-start justify-between gap-2">
                      <code className="text-xs font-mono text-muted-foreground break-all">
                        {command}
                      </code>
                      <button
                        type="button"
                        onClick={() => handleCopyCommand(command)}
                        className="shrink-0 p-1 hover:bg-muted rounded"
                      >
                        <Copy className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {commandPlatform === "windows"
                      ? t("addDeviceModal.runAsAdministratorInPowershell")
                      : t("addDeviceModal.runInTerminal")}
                  </p>
                </div>
              );
            })()}

            {/* Wait for connection */}
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">
                {t("addDeviceModal.step3WaitForConnection")}{" "}
              </p>
              <div className="rounded-md border border-blue-500/40 bg-blue-500/10 p-4 text-sm">
                <p className="text-blue-600 text-xs">
                  {tokenExpiresAt
                    ? `The installation token expires ${formatTokenExpiry(tokenExpiresAt)}.`
                    : t(
                        "addDeviceModal.theInstallationTokenExpiresAfterA",
                      )}{" "}
                  {t("addDeviceModal.yourDeviceWillAppearInThe")}{" "}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="mt-6 flex items-start justify-between gap-4">
          <div />
          <button
            type="button"
            onClick={onClose}
            className="h-10 shrink-0 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            {t("addDeviceModal.done")}{" "}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
