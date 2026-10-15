import { beforeEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PiOrchestrationOverview, PiOrchestrationWorker } from '@/lib/pi/protocol';

type StoreState = {
  overview: PiOrchestrationOverview | null;
  fetchedAt: number | null;
  error: string | null;
  refresh: () => Promise<void>;
};

let state: StoreState;
let pollingMounts = 0;
const opened: Array<{ sessionId: string; worktree: string | null }> = [];

mock.module('@/stores/useOrchestrationOverviewStore', () => ({
  useOrchestrationOverviewStore: <T,>(selector: (value: StoreState) => T) => selector(state),
  useOrchestrationOverviewPolling: () => { pollingMounts += 1; },
}));
mock.module('@/components/views/control-center/openWorkerSession', () => ({
  openWorkerSession: (worker: PiOrchestrationWorker) => { opened.push({ sessionId: worker.sessionId, worktree: worker.worktree }); },
}));
mock.module('@/components/icon/Icon', () => ({ Icon: () => null }));

const { ControlCenterView } = await import('./ControlCenterView');
const { WorkerRow } = await import('./control-center/WorkerRow');

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const MIN = 60_000;

const worker = (overrides: Partial<PiOrchestrationWorker> = {}): PiOrchestrationWorker => ({
  sessionId: 'worker-1',
  title: 'Fix the login',
  role: 'task-hard',
  profile: null,
  issue: { repo: 'acme/app', number: 7 },
  branch: '7-fix',
  worktree: '/wt/7-fix',
  pullRequest: { number: 12, repository: 'acme/app' },
  pullRequestStatus: { status: 'open', url: 'https://github.com/acme/app/pull/12', head: 'abc', checks: { state: 'failure', total: 3, pending: 0 } },
  lifecycle: 'active',
  lifecycleSince: NOW - 30 * MIN,
  live: 'busy',
  liveSince: NOW - MIN,
  lastProgressAt: NOW - 5 * MIN,
  lastInputAt: null,
  report: { kind: 'progress', summary: 'Tests are red, fixing the parser', at: NOW - 5 * MIN },
  question: { id: 'q1', kind: 'question', audience: 'owner', summary: 'Keep the old flag?', at: NOW - 2 * MIN },
  dialog: null,
  lastError: null,
  usage: null,
  ...overrides,
});

const overview = (orchestrators: PiOrchestrationOverview['orchestrators']): PiOrchestrationOverview => ({
  at: NOW,
  limit: { workerLimit: 4, used: 2 },
  host: { load1: 1.5, cores: 8, availableBytes: 12 * 1024 ** 3, workers: 2, limit: 4 },
  orchestrators,
  dialogs: [],
});

const render = () => renderToStaticMarkup(<ControlCenterView />);

describe('ControlCenterView', () => {
  beforeEach(() => {
    pollingMounts = 0;
    opened.length = 0;
    state = { overview: null, fetchedAt: null, error: null, refresh: async () => {} };
  });

  test('mounts the overview polling and shows loading before the first read', () => {
    const markup = render();
    expect(pollingMounts).toBe(1);
    expect(markup).toContain('Loading the control center');
    expect(markup).not.toContain('No orchestrators');
  });

  test('a failed first read shows the error with a retry, never an empty list', () => {
    state.error = 'daemon down';
    const markup = render();
    expect(markup).toContain('The control center could not be loaded');
    expect(markup).toContain('daemon down');
    expect(markup).toContain('Retry');
    expect(markup).not.toContain('No orchestrators');
  });

  test('an empty overview shows the empty state', () => {
    state.overview = overview([]);
    state.fetchedAt = NOW;
    const markup = render();
    expect(markup).toContain('No orchestrators');
    expect(markup).not.toContain('Stale');
  });

  test('a failed later read keeps the data and marks it stale with the read time', () => {
    state.overview = overview([{ sessionId: 'orch-1', marked: true, title: 'Orchestrator', workers: [worker()] }]);
    state.fetchedAt = NOW - 3 * MIN;
    state.error = 'daemon down';
    const markup = render();
    expect(markup).toContain('Fix the login');
    expect(markup).toContain('Stale: last read at');
    expect(markup).toContain('daemon down');
  });

  test('groups the workers by orchestrator and shows every worker field, slots and host', () => {
    state.overview = overview([
      { sessionId: 'orch-1', marked: true, title: 'Release orchestrator', workers: [worker(), worker({ sessionId: 'worker-2', title: 'Docs', issue: null, pullRequest: null, pullRequestStatus: null, question: null, report: { kind: 'done', summary: 'Docs merged', at: NOW - 2 * 60 * MIN }, live: null, lifecycle: 'done', lastProgressAt: null })] },
      { sessionId: 'orch-2', marked: false, title: null, workers: [worker({ sessionId: 'worker-3', title: 'Chaos run', question: { id: 'q2', kind: 'blocked', audience: 'orchestrator', summary: 'Lab is held', at: NOW } })] },
    ]);
    state.fetchedAt = NOW;
    const markup = render();

    // Slots and host.
    expect(markup).toContain('2 of 4 in use');
    expect(markup).toContain('1.50 on 8 cores');
    expect(markup).toContain('12.0 GiB free');

    // Groups in daemon order with their workers.
    const first = markup.indexOf('Release orchestrator');
    const second = markup.indexOf('orch-2');
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    expect(markup.indexOf('Fix the login')).toBeGreaterThan(first);
    expect(markup.indexOf('Fix the login')).toBeLessThan(second);
    expect(markup.indexOf('Chaos run')).toBeGreaterThan(second);
    expect(markup).toContain('2 workers');
    expect(markup).toContain('not running');
    expect(markup).toContain('no longer marked as orchestrator');

    // Worker fields: issue, lifecycle and live state, progress, report, question, pull request with CI.
    expect(markup).toContain('#7');
    expect(markup).toContain('active · working');
    expect(markup).toContain('progress 5 min ago');
    expect(markup).toContain('Progress');
    expect(markup).toContain('Tests are red, fixing the parser');
    expect(markup).toContain('Asks the owner');
    expect(markup).toContain('Keep the old flag?');
    expect(markup).toContain('#12 open');
    expect(markup).toContain('CI failed');
    expect(markup).toContain('Done');
    expect(markup).toContain('2 h ago: Docs merged');
    expect(markup).toContain('Blocked, asks the orchestrator');
  });

  test('selecting a worker opens its session with its worktree', () => {
    const row = (WorkerRow as unknown as { type: (props: unknown) => React.ReactElement<{ children: React.ReactElement<{ onClick: () => void; 'aria-label': string }> }> }).type;
    const element = row({ worker: worker({ sessionId: 'worker-9', live: 'dormant' }), now: NOW, onOpen: (value: PiOrchestrationWorker) => opened.push({ sessionId: value.sessionId, worktree: value.worktree }) });
    const button = element.props.children;
    expect(button.props['aria-label']).toBe('Open Fix the login');
    button.props.onClick();
    expect(opened).toEqual([{ sessionId: 'worker-9', worktree: '/wt/7-fix' }]);
  });
});
