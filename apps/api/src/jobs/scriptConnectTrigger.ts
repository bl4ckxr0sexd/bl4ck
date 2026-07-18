import { getEventBus } from '../services/eventBus';
import { isRedisAvailable } from '../services/redis';
import * as dbModule from '../db';
import { runOnConnectScriptsForDevice } from '../services/scriptConnectRun';

// Mirror automationWorker's system-context helper: fall back to a plain call if
// withSystemDbAccessContext isn't available (keeps unit tests that stub ../db
// working).
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = (dbModule as { withSystemDbAccessContext?: <R>(fn: () => Promise<R>) => Promise<R> })
    .withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

let unsubscribe: (() => void) | null = null;

/**
 * Subscribe to device.online and auto-run every eligible "run on connect"
 * script on the device (first connect only). Subscribes to the wildcard stream
 * and filters by type — the same pattern automationWorker uses — so it shares
 * the single EventBus consumer group rather than opening a second one.
 */
export async function initializeScriptConnectTrigger(): Promise<void> {
  if (unsubscribe) return;

  const eventBus = getEventBus();
  unsubscribe = eventBus.subscribe('*', async (event) => {
    try {
      if (event.type !== 'device.online') return;
      if (!isRedisAvailable()) return;

      const deviceId = (event.payload as { deviceId?: string } | undefined)?.deviceId;
      if (!deviceId || typeof deviceId !== 'string') return;

      await runWithSystemDbAccess(async () => {
        await runOnConnectScriptsForDevice(deviceId);
      });
    } catch (error) {
      console.error('[scriptConnectTrigger] Failed handling device.online:', error);
    }
  });

  console.log('[scriptConnectTrigger] Subscribed to device.online for run-on-connect scripts');
}

export async function shutdownScriptConnectTrigger(): Promise<void> {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
}
