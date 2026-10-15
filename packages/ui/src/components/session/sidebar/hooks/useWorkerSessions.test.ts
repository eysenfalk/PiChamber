import { describe, expect, test } from 'bun:test';
import type { PiOrchestrationOverview, PiOrchestrationWorker } from '@/lib/pi/protocol';
import { waitingWorkerIdsKey, workerIdsKey } from './useWorkerSessions';

const worker = (sessionId: string, question: PiOrchestrationWorker['question'] = null): PiOrchestrationWorker => ({
  sessionId,
  question,
  lifecycle: 'active',
} as PiOrchestrationWorker);

const question = { id: 'q1', kind: 'question' as const, audience: 'owner' as const, summary: 'Which port?', at: 1 };

const overview = (groups: PiOrchestrationWorker[][]): PiOrchestrationOverview => ({
  at: 1,
  limit: { workerLimit: 4, used: 0 },
  host: { load1: 0, cores: 8, availableBytes: 0, workers: 0, limit: 4 },
  orchestrators: groups.map((workers, index) => ({ sessionId: `orch-${index}`, marked: true, title: null, workers })),
  dialogs: [],
});

describe('worker session keys', () => {
  test('are unknown before the registry was read, so the filter shows everything', () => {
    expect(workerIdsKey(null)).toBeNull();
    expect(waitingWorkerIdsKey(null)).toBe('');
  });

  test('list every worker of every orchestrator, sorted, whatever its lifecycle', () => {
    const done = { ...worker('w-c'), lifecycle: 'done' } as PiOrchestrationWorker;
    expect(workerIdsKey(overview([[worker('w-b'), done], [worker('w-a')]]))).toBe('w-a\nw-b\nw-c');
  });

  test('an empty registry is known and empty, not unknown', () => {
    expect(workerIdsKey(overview([]))).toBe('');
  });

  test('waiting lists only workers with an open question', () => {
    expect(waitingWorkerIdsKey(overview([[worker('w-b', question), worker('w-a')], [worker('w-c', question)]]))).toBe('w-b\nw-c');
  });
});
