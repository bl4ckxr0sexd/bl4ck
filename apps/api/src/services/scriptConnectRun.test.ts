import { describe, it, expect, vi, beforeEach } from 'vitest';

// Chainable db + a fully-mocked executeScriptOnDevices — this test covers the
// eligibility/dedup logic, not the delivery internals (those are scriptExecution's).
vi.mock('../db', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));

vi.mock('./scriptExecution', () => ({
  executeScriptOnDevices: vi.fn(),
}));

import { db } from '../db';
import { executeScriptOnDevices } from './scriptExecution';
import { runOnConnectScriptsForDevice } from './scriptConnectRun';

// db.select() is called at most twice: device (.limit chain), then scripts (.where chain).
const deviceSelectChain = (rows: unknown[]) => ({
  from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }),
});
const scriptsSelectChain = (rows: unknown[]) => ({
  from: () => ({ where: () => Promise.resolve(rows) }),
});
const insertClaim = (rows: unknown[]) => ({
  values: () => ({ onConflictDoNothing: () => ({ returning: () => Promise.resolve(rows) }) }),
});
const updateChain = () => ({ set: () => ({ where: () => Promise.resolve(undefined) }) });
const deleteChain = () => ({ where: () => Promise.resolve(undefined) });

const device = (o: Record<string, unknown> = {}) => ({
  id: 'device-1',
  orgId: 'org-a',
  osType: 'windows',
  status: 'online',
  ...o,
});
const script = (o: Record<string, unknown> = {}) => ({
  id: 'script-1',
  orgId: 'org-a',
  runOnConnect: true,
  osTypes: ['windows'],
  deletedAt: null,
  ...o,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runOnConnectScriptsForDevice', () => {
  it('runs an eligible script once with a system actor and records the execution', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(deviceSelectChain([device()]) as never)
      .mockReturnValueOnce(scriptsSelectChain([script()]) as never);
    vi.mocked(db.insert).mockReturnValue(insertClaim([{ id: 'ledger-1' }]) as never);
    vi.mocked(db.update).mockReturnValue(updateChain() as never);
    vi.mocked(executeScriptOnDevices).mockResolvedValue({
      ok: true,
      executions: [{ executionId: 'exec-1', deviceId: 'device-1', commandId: 'cmd-1' }],
    } as never);

    await runOnConnectScriptsForDevice('device-1');

    expect(executeScriptOnDevices).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(executeScriptOnDevices).mock.calls[0]![0];
    expect(arg.scriptId).toBe('script-1');
    expect(arg.deviceIds).toEqual(['device-1']);
    expect(arg.triggerType).toBe('scheduled');
    expect(arg.triggeredByUserId).toBeNull(); // system-initiated, no user actor
    expect(db.update).toHaveBeenCalledTimes(1); // executionId recorded on the ledger
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('does not run again when the (script, device) claim already exists — first connect only', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(deviceSelectChain([device()]) as never)
      .mockReturnValueOnce(scriptsSelectChain([script()]) as never);
    vi.mocked(db.insert).mockReturnValue(insertClaim([]) as never); // ON CONFLICT → no row

    await runOnConnectScriptsForDevice('device-1');

    expect(executeScriptOnDevices).not.toHaveBeenCalled();
  });

  it('skips scripts whose OS does not match the device (never claims a slot)', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(deviceSelectChain([device({ osType: 'windows' })]) as never)
      .mockReturnValueOnce(scriptsSelectChain([script({ osTypes: ['linux'] })]) as never);

    await runOnConnectScriptsForDevice('device-1');

    expect(db.insert).not.toHaveBeenCalled();
    expect(executeScriptOnDevices).not.toHaveBeenCalled();
  });

  it('releases the claim when the run is suppressed (maintenance window / not executable)', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(deviceSelectChain([device()]) as never)
      .mockReturnValueOnce(scriptsSelectChain([script()]) as never);
    vi.mocked(db.insert).mockReturnValue(insertClaim([{ id: 'ledger-1' }]) as never);
    vi.mocked(db.delete).mockReturnValue(deleteChain() as never);
    vi.mocked(executeScriptOnDevices).mockResolvedValue({
      ok: false,
      status: 409,
      error: 'maintenance window',
    } as never);

    await runOnConnectScriptsForDevice('device-1');

    expect(executeScriptOnDevices).toHaveBeenCalledTimes(1);
    expect(db.delete).toHaveBeenCalledTimes(1); // claim released so a later connect retries
    expect(db.update).not.toHaveBeenCalled();
  });

  it('does nothing for a decommissioned device', async () => {
    vi.mocked(db.select).mockReturnValueOnce(
      deviceSelectChain([device({ status: 'decommissioned' })]) as never,
    );

    await runOnConnectScriptsForDevice('device-1');

    expect(db.insert).not.toHaveBeenCalled();
    expect(executeScriptOnDevices).not.toHaveBeenCalled();
  });

  it('does nothing when the device is not found', async () => {
    vi.mocked(db.select).mockReturnValueOnce(deviceSelectChain([]) as never);

    await runOnConnectScriptsForDevice('missing');

    expect(executeScriptOnDevices).not.toHaveBeenCalled();
  });
});
