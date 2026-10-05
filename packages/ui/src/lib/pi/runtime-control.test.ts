import { describe, expect, mock, test } from 'bun:test';

import { PiRequestError } from './client';
import { useSkillsStore } from '@/stores/useSkillsStore';
import { reloadPiRuntime, restartPiRuntime, summarizeReload, type RuntimeControlDeps } from './runtime-control';

type Notify = RuntimeControlDeps['notify'];

const makeNotify = () => {
  const events: Array<{ kind: string; message: string; options?: unknown }> = [];
  const record = (kind: string) => (message: unknown, options?: unknown) => {
    events.push({ kind, message: String(message), options });
    return 'id';
  };
  const notify = {
    success: record('success'),
    warning: record('warning'),
    error: record('error'),
    loading: record('loading'),
  } as unknown as Notify;
  return { events, notify };
};

describe('summarizeReload', () => {
  test('reports how many reloaded now and how many are deferred', () => {
    expect(summarizeReload({ reloaded: 3, deferred: 2, failed: 0 })).toEqual({
      level: 'success',
      message: 'Reloaded Pi in 3 sessions. 2 busy sessions reload when their turns end.',
    });
  });

  test('uses singular forms', () => {
    expect(summarizeReload({ reloaded: 1, deferred: 1, failed: 0 }).message)
      .toBe('Reloaded Pi in 1 session. 1 busy session reloads when its turn ends.');
  });

  test('warns about failures and says they are retried', () => {
    const summary = summarizeReload({ reloaded: 1, deferred: 0, failed: 2 });
    expect(summary.level).toBe('warning');
    expect(summary.message).toContain('2 sessions could not be reloaded');
  });

  test('says so when no session is loaded', () => {
    expect(summarizeReload({ reloaded: 0, deferred: 0, failed: 0 }).message).toContain('No Pi sessions are loaded');
  });
});

describe('reloadPiRuntime', () => {
  test('shows the summary toast on success', async () => {
    const { events, notify } = makeNotify();
    const ok = await reloadPiRuntime({
      client: { reloadRuntime: async () => ({ reloaded: 2, deferred: 1, failed: 0 }), restartRuntime: mock() },
      notify,
      refreshResources: () => {},
    });
    expect(ok).toBe(true);
    expect(events).toEqual([{ kind: 'success', message: 'Reloaded Pi in 2 sessions. 1 busy session reloads when its turn ends.', options: undefined }]);
  });

  test('refreshes the UI caches of skills, prompts and commands once the reload succeeded', async () => {
    const { notify } = makeNotify();
    let refreshCalls = 0;
    const refreshResources = () => { refreshCalls += 1; };
    await reloadPiRuntime({
      client: { reloadRuntime: async () => ({ reloaded: 1, deferred: 0, failed: 0 }), restartRuntime: mock() },
      notify,
      refreshResources,
    });
    expect(refreshCalls).toBe(1);
  });

  test('by default fetches the skills list that Settings shows again', async () => {
    const { notify } = makeNotify();
    let loadCalls = 0;
    const loadSkills = async () => { loadCalls += 1; return true; };
    const original = useSkillsStore.getState().loadSkills;
    useSkillsStore.setState({ loadSkills });
    try {
      await reloadPiRuntime({
        client: { reloadRuntime: async () => ({ reloaded: 1, deferred: 0, failed: 0 }), restartRuntime: mock() },
        notify,
      });
      expect(loadCalls).toBe(1);
    } finally {
      useSkillsStore.setState({ loadSkills: original });
    }
  });

  test('does not refresh when the reload call fails', async () => {
    const { notify } = makeNotify();
    let refreshCalls = 0;
    const refreshResources = () => { refreshCalls += 1; };
    await reloadPiRuntime({
      client: { reloadRuntime: async () => { throw new PiRequestError('DAEMON_UNAVAILABLE'); }, restartRuntime: mock() },
      notify,
      refreshResources,
    });
    expect(refreshCalls).toBe(0);
  });

  test('shows an error toast when the call fails', async () => {
    const { events, notify } = makeNotify();
    const ok = await reloadPiRuntime({
      client: { reloadRuntime: async () => { throw new PiRequestError('DAEMON_UNAVAILABLE'); }, restartRuntime: mock() },
      notify,
    });
    expect(ok).toBe(false);
    expect(events.map((event) => event.kind)).toEqual(['error']);
  });
});

describe('restartPiRuntime', () => {
  const clock = () => {
    let now = 0;
    return {
      now: () => now,
      wait: async (milliseconds: number) => { now += milliseconds; },
    };
  };

  test('shows a reconnecting state, waits for a new stream epoch, then reports success', async () => {
    const { events, notify } = makeNotify();
    const health = [
      { state: 'ready', streamEpoch: 'old' }, // before the restart
      { state: 'ready', streamEpoch: 'old' }, // the old process still answering
      { state: 'unavailable' }, // between processes
      { state: 'ready', streamEpoch: 'new' },
    ];
    const ok = await restartPiRuntime({
      client: { reloadRuntime: mock(), restartRuntime: async () => ({ accepted: true, scope: 'process' }) },
      fetchHealth: (async () => health.shift()) as unknown as RuntimeControlDeps['fetchHealth'],
      notify,
      ...clock(),
    });
    expect(ok).toBe(true);
    expect(events.map((event) => event.kind)).toEqual(['loading', 'success']);
    expect(events[0].message).toContain('Reconnecting');
    expect(health).toHaveLength(0);
  });

  test('keeps waiting while the health request itself fails', async () => {
    const { notify, events } = makeNotify();
    let calls = 0;
    const ok = await restartPiRuntime({
      client: { reloadRuntime: mock(), restartRuntime: async () => ({ accepted: true, scope: 'process' }) },
      fetchHealth: (async () => {
        calls += 1;
        if (calls === 1) return { state: 'ready', streamEpoch: 'old' };
        if (calls < 4) throw new Error('connection refused');
        return { state: 'ready', streamEpoch: 'new' };
      }) as unknown as RuntimeControlDeps['fetchHealth'],
      notify,
      ...clock(),
    });
    expect(ok).toBe(true);
    expect(events.at(-1)?.kind).toBe('success');
  });

  test('says only the daemon restarted when the server cannot restart itself', async () => {
    const { events, notify } = makeNotify();
    const health = [{ state: 'ready', streamEpoch: 'old' }, { state: 'ready', streamEpoch: 'new' }];
    const ok = await restartPiRuntime({
      client: { reloadRuntime: mock(), restartRuntime: async () => ({ accepted: true, scope: 'daemon' }) },
      fetchHealth: (async () => health.shift()) as unknown as RuntimeControlDeps['fetchHealth'],
      notify,
      ...clock(),
    });
    expect(ok).toBe(true);
    expect(events.at(-1)?.kind).toBe('warning');
    expect(events.at(-1)?.message).toContain('Only the Pi session daemon restarted');
  });

  test('shows the error and never starts waiting when the restart is rejected', async () => {
    const { events, notify } = makeNotify();
    const ok = await restartPiRuntime({
      client: {
        reloadRuntime: mock(),
        restartRuntime: async () => { throw new PiRequestError('RESTART_FAILED', 'The restart failed (DAEMON_STOP_TIMEOUT).', 500); },
      },
      fetchHealth: (async () => ({ state: 'ready', streamEpoch: 'old' })) as unknown as RuntimeControlDeps['fetchHealth'],
      notify,
      ...clock(),
    });
    expect(ok).toBe(false);
    expect(events).toEqual([{ kind: 'error', message: 'The restart failed (DAEMON_STOP_TIMEOUT).', options: undefined }]);
  });

  test('explains an unsupported host', async () => {
    const { events, notify } = makeNotify();
    await restartPiRuntime({
      client: { reloadRuntime: mock(), restartRuntime: async () => { throw new PiRequestError('RESTART_UNSUPPORTED', undefined, 501); } },
      fetchHealth: (async () => ({ state: 'ready' })) as unknown as RuntimeControlDeps['fetchHealth'],
      notify,
      ...clock(),
    });
    expect(events[0].message).toBe('This server cannot be restarted from here.');
  });

  test('reports an error when the runtime does not come back in time', async () => {
    const { events, notify } = makeNotify();
    const ok = await restartPiRuntime({
      client: { reloadRuntime: mock(), restartRuntime: async () => ({ accepted: true, scope: 'process' }) },
      fetchHealth: (async () => ({ state: 'unavailable' })) as unknown as RuntimeControlDeps['fetchHealth'],
      notify,
      ...clock(),
    });
    expect(ok).toBe(false);
    expect(events.map((event) => event.kind)).toEqual(['loading', 'error']);
  });
});
