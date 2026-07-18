import { and, eq, isNull } from 'drizzle-orm';

import { db } from '../db';
import { devices, scriptConnectRuns, scripts } from '../db/schema';
import { executeScriptOnDevices } from './scriptExecution';

/**
 * Run every eligible "run on connect" script on a device that just came online,
 * exactly once per (script, device). Invoked from the device.online event
 * subscriber (scriptConnectTrigger) inside a system DB-access context.
 *
 * Eligibility (v1): org-owned scripts (scripts.org_id === device.org_id) that
 * are opted in (run_on_connect), not soft-deleted, and OS-compatible. Delivery,
 * maintenance-window suppression, decommissioned-device filtering, and command
 * dispatch are all delegated to executeScriptOnDevices — this function only
 * decides *which* scripts fire and enforces first-connect-only dedup.
 *
 * Dedup is claim-first: we INSERT the ledger row with ON CONFLICT DO NOTHING
 * BEFORE running. A concurrent device.online for the same device loses the race
 * (no row returned) and skips, so the script never double-runs. If the run
 * turns out to be suppressed (maintenance window) or errors, the claim is
 * released so a later connect retries.
 */
export async function runOnConnectScriptsForDevice(deviceId: string): Promise<void> {
  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!device) return;
  if (device.status === 'decommissioned') return;

  const candidates = await db
    .select()
    .from(scripts)
    .where(
      and(
        eq(scripts.orgId, device.orgId),
        eq(scripts.runOnConnect, true),
        isNull(scripts.deletedAt),
      ),
    );

  for (const script of candidates) {
    // OS filter here (not just inside executeScriptOnDevices) so an
    // OS-incompatible script never claims a ledger slot it can't use.
    if (!script.osTypes.includes(device.osType)) continue;

    // Claim the (script, device) slot. No row back ⇒ already ran (or a racing
    // sibling won) ⇒ first-connect-only holds, skip.
    const [claim] = await db
      .insert(scriptConnectRuns)
      .values({ orgId: device.orgId, scriptId: script.id, deviceId: device.id })
      .onConflictDoNothing({
        target: [scriptConnectRuns.scriptId, scriptConnectRuns.deviceId],
      })
      .returning();

    if (!claim) continue;

    try {
      const result = await executeScriptOnDevices({
        scriptId: script.id,
        deviceIds: [device.id],
        triggerType: 'scheduled',
        triggeredByUserId: null, // system-initiated; no user actor
        auth: { user: { id: '' }, orgId: device.orgId, canAccessOrg: () => true },
      });

      if (result.ok) {
        const executionId = result.executions[0]?.executionId ?? null;
        if (executionId) {
          await db
            .update(scriptConnectRuns)
            .set({ executionId })
            .where(eq(scriptConnectRuns.id, claim.id));
        }
      } else {
        // Not actually executed (maintenance-window suppression, no compatible
        // device, etc.). Release the claim so a later connect retries.
        await db.delete(scriptConnectRuns).where(eq(scriptConnectRuns.id, claim.id));
        console.warn('[runOnConnect] script not executed; released claim', {
          scriptId: script.id,
          deviceId: device.id,
          status: result.status,
          error: result.error,
        });
      }
    } catch (err) {
      await db
        .delete(scriptConnectRuns)
        .where(eq(scriptConnectRuns.id, claim.id))
        .catch(() => {});
      console.error('[runOnConnect] execution error; released claim', {
        scriptId: script.id,
        deviceId: device.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
