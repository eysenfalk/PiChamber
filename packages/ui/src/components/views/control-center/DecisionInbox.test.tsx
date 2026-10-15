import { describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PiOrchestrationOverview, PiOrchestrationWorker } from '@/lib/pi/protocol';

mock.module('@/components/icon/Icon', () => ({ Icon: () => null }));
mock.module('@/lib/pi/client', () => ({ PiRequestError: class extends Error {}, piClient: {} }));
mock.module('@/components/chat/extensionDialogResponse', () => ({ answerExtensionDialog: async () => {} }));
mock.module('@/components/views/control-center/openWorkerSession', () => ({ openWorkerSession: () => {} }));

const { DecisionInbox } = await import('./DecisionInbox');
const { controlCenterEntryLabel } = await import('./useDecisionInboxCount');

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const MIN = 60_000;

const worker = (overrides: Partial<PiOrchestrationWorker>): PiOrchestrationWorker => ({
  sessionId: 'w-1',
  title: 'Fix the login',
  role: 'task-hard',
  profile: null,
  issue: null,
  branch: null,
  worktree: '/wt/7-fix-login',
  pullRequest: null,
  pullRequestStatus: null,
  lifecycle: 'active',
  lifecycleSince: NOW,
  live: 'idle',
  liveSince: NOW,
  lastProgressAt: null,
  lastInputAt: null,
  report: null,
  question: null,
  dialog: null,
  lastError: null,
  usage: null,
  ...overrides,
});

const overview = (): PiOrchestrationOverview => ({
  at: NOW,
  limit: { workerLimit: 4, used: 2 },
  host: { load1: 1, cores: 8, availableBytes: 8 * 1024 ** 3, workers: 2, limit: 4 },
  orchestrators: [{
    sessionId: 'orch-1',
    marked: true,
    title: 'Release',
    workers: [
      worker({
        question: {
          id: 'q-1', kind: 'question', audience: 'owner', summary: 'Keep the old flag?', at: NOW - 3 * MIN,
          brief: { options: ['Keep it', 'Drop it'], recommendation: 'Drop it', counterargument: 'Old clients break', revisit: 'A client reports it' },
        },
      }),
      worker({
        sessionId: 'w-2', title: 'Chaos run', worktree: '/wt/chaos',
        question: { id: 'q-2', kind: 'blocked', audience: 'orchestrator', summary: 'Lab is held', at: NOW - MIN },
      }),
    ],
  }],
  dialogs: [{
    sessionId: 's-9', title: 'Deploy', directory: '/repo/site', orchestratorSessionId: null,
    dialog: { requestId: 'd-1', method: 'select', title: 'Pick a target', options: ['staging', 'production'] },
  }],
});

const render = (value: PiOrchestrationOverview) => renderToStaticMarkup(<DecisionInbox overview={value} runtimeKey="local" onRefresh={() => {}} />);

describe('DecisionInbox', () => {
  test('shows the owner question with its brief, then the dialog, then the question for the orchestrator', () => {
    const markup = render(overview());
    expect(markup).toContain('2 wait for you');

    const dialogAt = markup.indexOf('Pick a target');
    const ownerAt = markup.indexOf('Keep the old flag?');
    const orchestratorAt = markup.indexOf('Lab is held');
    expect(ownerAt).toBeGreaterThan(-1);
    expect(dialogAt).toBeGreaterThan(ownerAt);
    expect(orchestratorAt).toBeGreaterThan(dialogAt);

    // Session, project and age.
    expect(markup).toContain('Deploy');
    expect(markup).toContain('site');
    expect(markup).toContain('Fix the login');
    expect(markup).toContain('7-fix-login');
    expect(markup).toContain('3 min ago');

    // The brief.
    expect(markup).toContain('Keep it');
    expect(markup).toContain('Recommendation');
    expect(markup).toContain('Drop it');
    expect(markup).toContain('Old clients break');
    expect(markup).toContain('A client reports it');

    // The orchestrator question is marked and still answerable.
    expect(markup).toContain('For the orchestrator');
    expect(markup).toContain('Blocked');
    expect(markup).toContain('aria-label="Answer to Chaos run"');

    // Dialog controls are the in-session ones; every entry opens its session.
    expect(markup).toContain('staging');
    expect(markup).toContain('production');
    expect(markup.match(/Open session/g)?.length).toBe(6);
    expect(markup.match(/Send answer/g)?.length).toBe(2);
    expect(markup).toContain('Mark answered');
  });

  test('an empty inbox says nothing waits', () => {
    const markup = render({ ...overview(), orchestrators: [], dialogs: [] });
    expect(markup).toContain('nothing waits for you');
    expect(markup).toContain('No open questions or dialogs.');
  });

  test('the control center entry names the count only when there is one', () => {
    expect(controlCenterEntryLabel(false, null)).toBe('Open control center');
    expect(controlCenterEntryLabel(false, 0)).toBe('Open control center');
    expect(controlCenterEntryLabel(false, 1)).toBe('Open control center, 1 decision waiting');
    expect(controlCenterEntryLabel(true, 3)).toBe('Close control center, 3 decisions waiting');
  });
});
