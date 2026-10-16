import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type {
  PiExtensionDialogPayload,
  PiOrchestrationOverview,
  PiOrchestrationQuestion,
  PiOrchestrationWorker,
} from '@/lib/pi/protocol';

class FakeRequestError extends Error {
  readonly code: string;
  readonly status?: number;
  constructor(code: string, message?: string, status?: number) {
    super(message ?? `Pi request failed: ${code}`);
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

const answers: Array<{ sessionId: string; questionId: string; input: unknown; scope: unknown }> = [];
const resolves: Array<{ sessionId: string; questionId: string; scope: unknown }> = [];
const dialogAnswers: Array<{ sessionId: string; requestId: string; answer: unknown }> = [];
let answerResult: () => Promise<{ resolved: boolean }>;
let resolveResult: () => Promise<unknown>;
let dialogResult: () => Promise<void>;

mock.module('@/lib/pi/client', () => ({
  PiRequestError: FakeRequestError,
  piClient: {
    answerOrchestrationQuestion: (sessionId: string, questionId: string, input: unknown, scope: unknown) => {
      answers.push({ sessionId, questionId, input, scope });
      return answerResult();
    },
    resolveOrchestrationQuestion: (sessionId: string, questionId: string, scope: unknown) => {
      resolves.push({ sessionId, questionId, scope });
      return resolveResult();
    },
  },
}));
mock.module('@/components/chat/extensionDialogResponse', () => ({
  answerExtensionDialog: (sessionId: string, request: PiExtensionDialogPayload, answer: unknown) => {
    dialogAnswers.push({ sessionId, requestId: request.requestId, answer });
    return dialogResult();
  },
}));

const inbox = await import('./decisionInboxModel');
const { EMPTY_ANSWER_DRAFT, answerAttempt, answerDraftReducer } = inbox;

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const MIN = 60_000;

const question = (id: string, audience: 'owner' | 'orchestrator', at: number): PiOrchestrationQuestion => ({
  id, kind: 'question', audience, summary: `asks ${id}`, at,
});

const worker = (sessionId: string, q: PiOrchestrationQuestion | null): PiOrchestrationWorker => ({
  sessionId,
  title: `Worker ${sessionId}`,
  role: 'task-hard',
  profile: null,
  issue: null,
  branch: null,
  worktree: `/wt/${sessionId}`,
  pullRequest: null,
  pullRequestStatus: null,
  lifecycle: 'active',
  lifecycleSince: NOW,
  live: 'idle',
  liveSince: NOW,
  lastProgressAt: null,
  lastInputAt: null,
  report: null,
  question: q,
  dialog: null,
  lastError: null,
  usage: null,
});

const dialog = (requestId: string): PiExtensionDialogPayload => ({ requestId, method: 'confirm', title: `Dialog ${requestId}` });

const overview = (): PiOrchestrationOverview => ({
  at: NOW,
  limit: { workerLimit: 4, used: 3 },
  host: { load1: 1, cores: 8, availableBytes: 8 * 1024 ** 3, workers: 2, limit: 4 },
  orchestrators: [
    { sessionId: 'orch-1', marked: true, title: 'One', workers: [worker('w-old', question('q-old', 'owner', NOW - 10 * MIN)), worker('w-orch', question('q-orch', 'orchestrator', NOW - MIN)), worker('w-none', null)] },
    { sessionId: 'orch-2', marked: true, title: 'Two', workers: [worker('w-new', question('q-new', 'owner', NOW - 2 * MIN)), worker('w-orch-old', question('q-orch-old', 'orchestrator', NOW - 30 * MIN))] },
  ],
  dialogs: [
    { sessionId: 's-first', title: null, directory: '/repo/app', orchestratorSessionId: null, dialog: dialog('d-first') },
    { sessionId: 'w-old', title: 'Worker w-old', directory: '/wt/w-old', orchestratorSessionId: 'orch-1', dialog: dialog('d-second') },
  ],
});

describe('decision inbox model', () => {
  beforeEach(() => {
    answers.length = 0;
    resolves.length = 0;
    dialogAnswers.length = 0;
    answerResult = async () => ({ resolved: true });
    resolveResult = async () => ({ resolved: true });
    dialogResult = async () => {};
  });

  test('orders owner questions first, then dialogs, then orchestrator questions, each newest first', () => {
    const keys = inbox.collectInboxItems(overview()).map((item) => item.key);
    expect(keys).toEqual([
      'question:w-new:q-new',
      'question:w-old:q-old',
      'dialog:w-old:d-second',
      'dialog:s-first:d-first',
      'question:w-orch:q-orch',
      'question:w-orch-old:q-orch-old',
    ]);
  });

  test('carries session and project for questions and dialogs', () => {
    const items = inbox.collectInboxItems(overview());
    const untitled = items.find((item) => item.key === 'dialog:s-first:d-first');
    expect(untitled).toMatchObject({ kind: 'dialog', title: 's-first', directory: '/repo/app' });
    expect(items.find((item) => item.key === 'question:w-new:q-new')).toMatchObject({ kind: 'question', title: 'Worker w-new', worktree: '/wt/w-new' });
    expect(inbox.projectLabel('/repo/app/')).toBe('app');
    expect(inbox.projectLabel('C:\\work\\repo')).toBe('repo');
    expect(inbox.projectLabel(null)).toBeNull();
  });

  test('reads options in the #210 shape and the plain strings stored before it', () => {
    expect(inbox.briefOptions({ recommendation: 'x', options: [{ label: 'Fail', consequence: 'Blocks the release', recommended: true }, { label: 'Warn' }] })).toEqual([
      { label: 'Fail', consequence: 'Blocks the release', recommended: true },
      { label: 'Warn', consequence: null, recommended: false },
    ]);
    expect(inbox.briefOptions({ recommendation: 'x', options: ['Keep it', 'Drop it'] })).toEqual([
      { label: 'Keep it', consequence: null, recommended: false },
      { label: 'Drop it', consequence: null, recommended: false },
    ]);
    expect(inbox.briefOptions(undefined)).toEqual([]);
  });

  test('an option answer is the label, with the typed note as its own paragraph', () => {
    expect(inbox.optionAnswerText('Fail', '')).toBe('Fail');
    expect(inbox.optionAnswerText('Fail', '  \n ')).toBe('Fail');
    expect(inbox.optionAnswerText('Fail', ' but only on main ')).toBe('Fail\n\nbut only on main');
  });

  test('links the worker issue and pull request, preferring the URL the pull request watch read', () => {
    const base = { issue: null, pullRequest: null, pullRequestStatus: null };
    expect(inbox.workLinks(base)).toEqual([]);
    expect(inbox.workLinks({ ...base, issue: { repo: 'acme/app', number: 7 }, pullRequest: { number: 12, repository: 'acme/app' } })).toEqual([
      { label: 'Issue #7', url: 'https://github.com/acme/app/issues/7' },
      { label: 'PR #12', url: 'https://github.com/acme/app/pull/12' },
    ]);
    const status = { status: 'open' as const, url: 'https://git.example/pr/12', head: null, checks: null };
    expect(inbox.workLinks({ ...base, pullRequest: { number: 12, repository: null }, pullRequestStatus: status })).toEqual([{ label: 'PR #12', url: 'https://git.example/pr/12' }]);
    expect(inbox.workLinks({ ...base, pullRequest: { number: 12, repository: null } })).toEqual([{ label: 'PR #12', url: null }]);
  });

  test('counts owner questions and dialogs, not questions to the orchestrator', () => {
    expect(inbox.countOpenDecisions(overview())).toBe(4);
    expect(inbox.countOpenDecisions({ ...overview(), orchestrators: [], dialogs: [] })).toBe(0);
  });

  test('an answer goes to the question with its request id and runtime', async () => {
    const outcome = await inbox.sendQuestionAnswer({ sessionId: 'w-new', questionId: 'q-new' }, 'use v2', 'req-1', 'local');
    expect(outcome).toEqual({ status: 'sent', resolved: true });
    expect(answers).toEqual([{ sessionId: 'w-new', questionId: 'q-new', input: { text: 'use v2', clientRequestId: 'req-1' }, scope: { runtimeKey: 'local' } }]);
  });

  test('a question that is no longer open is closed, any other error is a failure', async () => {
    answerResult = async () => { throw new FakeRequestError('ORCHESTRATION_QUESTION_UNKNOWN', 'This question is not open.', 409); };
    expect(await inbox.sendQuestionAnswer({ sessionId: 'w', questionId: 'q' }, 'x', 'r', 'local')).toEqual({ status: 'closed' });
    answerResult = async () => { throw new FakeRequestError('PI_UNAVAILABLE', 'daemon down', 503); };
    expect(await inbox.sendQuestionAnswer({ sessionId: 'w', questionId: 'q' }, 'x', 'r', 'local')).toEqual({ status: 'failed', message: 'daemon down' });
    resolveResult = async () => { throw new FakeRequestError('ORCHESTRATION_QUESTION_UNKNOWN', 'gone', 409); };
    expect(await inbox.markQuestionAnswered({ sessionId: 'w', questionId: 'q' }, 'local')).toEqual({ status: 'closed' });
    expect(resolves).toEqual([{ sessionId: 'w', questionId: 'q', scope: { runtimeKey: 'local' } }]);
  });

  test('a failed answer keeps the text and the attempt, so retrying the same text cannot prompt twice', () => {
    let draft = answerDraftReducer(EMPTY_ANSWER_DRAFT, { type: 'edit', text: 'use v2' });
    const first = { id: 'req-1', text: 'use v2' };
    draft = answerDraftReducer(draft, { type: 'start', action: 'answer', attempt: first });
    expect(draft.pending).toBe('answer');
    expect(answerDraftReducer(draft, { type: 'start', action: 'resolve' })).toBe(draft);
    draft = answerDraftReducer(draft, { type: 'settled', action: 'answer', outcome: { status: 'failed', message: 'daemon down' } });
    expect(draft).toEqual({ text: 'use v2', attempt: first, pending: null, notice: { tone: 'error', text: 'Could not send the answer. daemon down' } });
    let ids = 0;
    const newId = () => `req-new-${++ids}`;
    expect(answerAttempt(draft.attempt, 'use v2', newId)).toBe(first);
    // The daemon refuses a request id reused with other text, so another option or an edited answer gets a new one.
    expect(answerAttempt(draft.attempt, 'Warn only', newId)).toEqual({ id: 'req-new-1', text: 'Warn only' });
    draft = answerDraftReducer(draft, { type: 'start', action: 'answer', attempt: first });
    expect(draft.notice).toBeNull();
  });

  test('a sent answer clears the draft; a closed question drops the attempt and says so', () => {
    const sending = answerDraftReducer({ ...EMPTY_ANSWER_DRAFT, text: 'use v2' }, { type: 'start', action: 'answer', attempt: { id: 'req-1', text: 'use v2' } });
    expect(answerDraftReducer(sending, { type: 'settled', action: 'answer', outcome: { status: 'sent', resolved: true } }))
      .toEqual({ text: '', attempt: null, pending: null, notice: { tone: 'info', text: 'Answer sent.' } });
    expect(answerDraftReducer(sending, { type: 'settled', action: 'answer', outcome: { status: 'sent', resolved: false } }).notice?.text)
      .toBe('Answer sent. The worker replaced the question in the meantime.');
    expect(answerDraftReducer(sending, { type: 'settled', action: 'answer', outcome: { status: 'closed' } }))
      .toEqual({ text: 'use v2', attempt: null, pending: null, notice: { tone: 'info', text: 'This question is no longer open.' } });
  });

  test('a dialog is answered through the shared dialog path, then the overview is reread', async () => {
    let refreshes = 0;
    const item = { sessionId: 's-first', dialog: dialog('d-first') };
    expect(await inbox.submitInboxDialog(item, { confirmed: true }, () => { refreshes += 1; })).toBe(true);
    expect(dialogAnswers).toEqual([{ sessionId: 's-first', requestId: 'd-first', answer: { confirmed: true } }]);
    expect(refreshes).toBe(1);

    dialogResult = async () => { throw new Error('offline'); };
    expect(await inbox.submitInboxDialog(item, { cancelled: true }, () => { refreshes += 1; })).toBe(false);
    expect(refreshes).toBe(1);
  });
});
