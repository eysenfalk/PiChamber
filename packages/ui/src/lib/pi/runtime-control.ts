import { toast } from '@/components/ui';
import { invalidateCommandCatalogCache } from '@/lib/pi/commandCatalog';
import { invalidatePromptTemplatesLoadCache } from '@/stores/usePromptTemplatesStore';
import { invalidateSkillsLoadCache, useSkillsStore } from '@/stores/useSkillsStore';
import { piClient, PiRequestError } from './client';
import { fetchPiRuntimeHealth } from './transport';
import type { PiRuntimeReloadResult, PiRuntimeRestartResult } from './protocol';

/**
 * "Reload Pi" and "Restart PiChamber" from Settings. Both go through
 * `piClient`, so every runtime (web, desktop, hosted mobile, Capacitor) uses
 * the same server routes. After a restart the shared stream transport
 * reconnects by itself and its stream-epoch recovery resyncs sessions; this
 * module only reports progress and waits for the runtime to answer again.
 */

const RESTART_TOAST_ID = 'pichamber-runtime-restart';
const RESTART_POLL_INTERVAL_MS = 1_000;
const RESTART_RETURN_TIMEOUT_MS = 90_000;

const sessionCount = (count: number): string => (count === 1 ? '1 session' : `${count} sessions`);

export const summarizeReload = (result: PiRuntimeReloadResult): { level: 'success' | 'warning'; message: string } => {
  const parts: string[] = [];
  if (result.reloaded > 0) parts.push(`Reloaded Pi in ${sessionCount(result.reloaded)}.`);
  if (result.deferred > 0) {
    parts.push(
      result.deferred === 1
        ? '1 busy session reloads when its turn ends.'
        : `${result.deferred} busy sessions reload when their turns end.`,
    );
  }
  if (result.failed > 0) {
    parts.push(
      result.failed === 1
        ? '1 session could not be reloaded and will try again when its turn ends.'
        : `${result.failed} sessions could not be reloaded and will try again when their turns end.`,
    );
  }
  if (parts.length === 0) parts.push('No Pi sessions are loaded. New sessions start with the current extensions and skills.');
  return { level: result.failed > 0 ? 'warning' : 'success', message: parts.join(' ') };
};

const describeFailure = (error: unknown, fallback: string): string => {
  if (error instanceof PiRequestError && error.message && !error.message.startsWith('Pi request failed')) return error.message;
  if (error instanceof PiRequestError && error.status === 501) return 'This server cannot be restarted from here.';
  return fallback;
};

export interface RuntimeControlDeps {
  client: Pick<typeof piClient, 'reloadRuntime' | 'restartRuntime'>;
  fetchHealth: typeof fetchPiRuntimeHealth;
  notify: Pick<typeof toast, 'success' | 'warning' | 'error' | 'loading'>;
  wait: (milliseconds: number) => Promise<void>;
  now: () => number;
  /** Drops what the UI cached about discovered skills, prompts and slash commands. */
  refreshResources: () => void;
}

// A reload changes what Pi discovers, but the UI keeps its own caches of
// skills, prompts and the slash-command catalog, so they are invalidated and
// the skills list that Settings shows is fetched again.
const refreshDiscoveredResources = (): void => {
  invalidateCommandCatalogCache();
  invalidatePromptTemplatesLoadCache();
  invalidateSkillsLoadCache();
  void useSkillsStore.getState().loadSkills();
};

const defaultDeps = (): RuntimeControlDeps => ({
  client: piClient,
  fetchHealth: fetchPiRuntimeHealth,
  notify: toast,
  wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now: () => Date.now(),
  refreshResources: refreshDiscoveredResources,
});

/** Reloads every loaded Pi session and reports how many reloaded now and how many are deferred. Returns whether the call succeeded. */
export const reloadPiRuntime = async (overrides: Partial<RuntimeControlDeps> = {}): Promise<boolean> => {
  const deps = { ...defaultDeps(), ...overrides };
  try {
    const result = await deps.client.reloadRuntime();
    deps.refreshResources();
    const { level, message } = summarizeReload(result);
    deps.notify[level](message);
    return true;
  } catch (error) {
    deps.notify.error(describeFailure(error, 'Pi could not be reloaded.'));
    return false;
  }
};

const describeRestartScope = (scope: PiRuntimeRestartResult['scope']): string => (
  scope === 'process'
    ? 'PiChamber is restarting.'
    : 'Only the Pi session daemon restarted. This server cannot restart itself; restart it from its host to load a new server build.'
);

/**
 * Waits until the runtime answers health again. `previousStreamEpoch` is the
 * epoch of the daemon that was running before the restart: a restarted daemon
 * always has a new one, so "ready with the same epoch" is still the old
 * daemon (or the old server answering before it exits).
 */
const waitForRuntimeReturn = async (
  deps: RuntimeControlDeps,
  previousStreamEpoch: string | undefined,
): Promise<boolean> => {
  const deadline = deps.now() + RESTART_RETURN_TIMEOUT_MS;
  while (deps.now() < deadline) {
    await deps.wait(RESTART_POLL_INTERVAL_MS);
    try {
      const health = await deps.fetchHealth(undefined, undefined, { fresh: true });
      if (health.state === 'ready' && (!previousStreamEpoch || health.streamEpoch !== previousStreamEpoch)) return true;
    } catch {
      // The server is down or restarting; keep waiting.
    }
  }
  return false;
};

/**
 * Restarts PiChamber and shows a reconnecting state until the runtime is back.
 * A rejected request leaves the running server untouched and reports the error.
 */
export const restartPiRuntime = async (overrides: Partial<RuntimeControlDeps> = {}): Promise<boolean> => {
  const deps = { ...defaultDeps(), ...overrides };
  let previousStreamEpoch: string | undefined;
  try {
    previousStreamEpoch = (await deps.fetchHealth(undefined, undefined, { fresh: true })).streamEpoch;
  } catch {
    previousStreamEpoch = undefined;
  }

  let result: PiRuntimeRestartResult;
  try {
    result = await deps.client.restartRuntime();
  } catch (error) {
    deps.notify.error(describeFailure(error, 'PiChamber could not be restarted.'));
    return false;
  }

  deps.notify.loading('Restarting PiChamber. Reconnecting...', { id: RESTART_TOAST_ID, duration: Infinity });
  if (!(await waitForRuntimeReturn(deps, previousStreamEpoch))) {
    deps.notify.error('PiChamber did not come back in time. Check the server and reload the page.', { id: RESTART_TOAST_ID, duration: 10_000 });
    return false;
  }
  if (result.scope === 'daemon') {
    deps.notify.warning(describeRestartScope('daemon'), { id: RESTART_TOAST_ID, duration: 10_000 });
  } else {
    deps.notify.success('PiChamber restarted.', { id: RESTART_TOAST_ID });
  }
  return true;
};
