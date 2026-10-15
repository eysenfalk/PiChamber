import type {
  PiExtensionDialogPayload,
  PiOrchestrationOverview,
  PiOrchestrationPendingDialog,
  PiOrchestrationQuestion,
} from '@/lib/pi/protocol';
import { PiRequestError, piClient } from '@/lib/pi/client';
import { answerExtensionDialog, type DialogAnswer } from '@/components/chat/extensionDialogResponse';

/**
 * The decision inbox (#20, #87): what waits for an answer across sessions and
 * projects, read from the orchestration overview only.
 *
 * Order: the questions to the owner first, newest first by the question's own
 * time. Then the pending extension dialogs, which also wait for the owner; the
 * daemon lists them in arrival order and carries no time, so the newest is
 * last and the inbox reverses them. Last the questions to the orchestrator,
 * newest first.
 */

export type InboxQuestion = {
  kind: 'question';
  key: string;
  sessionId: string;
  title: string;
  worktree: string | null;
  question: PiOrchestrationQuestion;
};

export type InboxDialog = {
  kind: 'dialog';
  key: string;
  sessionId: string;
  title: string;
  directory: string | null;
  dialog: PiExtensionDialogPayload;
};

type InboxItem = InboxQuestion | InboxDialog;

const newestFirst = (a: InboxQuestion, b: InboxQuestion): number => b.question.at - a.question.at;

const dialogItem = (pending: PiOrchestrationPendingDialog): InboxDialog => ({
  kind: 'dialog',
  key: `dialog:${pending.sessionId}:${pending.dialog.requestId}`,
  sessionId: pending.sessionId,
  title: pending.title?.trim() || pending.sessionId,
  directory: pending.directory,
  dialog: pending.dialog,
});

export const collectInboxItems = (overview: PiOrchestrationOverview): InboxItem[] => {
  const owner: InboxQuestion[] = [];
  const orchestrator: InboxQuestion[] = [];
  for (const group of overview.orchestrators) {
    for (const worker of group.workers) {
      const question = worker.question;
      if (!question) continue;
      const item: InboxQuestion = {
        kind: 'question',
        key: `question:${worker.sessionId}:${question.id}`,
        sessionId: worker.sessionId,
        title: worker.title?.trim() || worker.sessionId,
        worktree: worker.worktree,
        question,
      };
      (question.audience === 'owner' ? owner : orchestrator).push(item);
    }
  }
  const dialogs = overview.dialogs.map(dialogItem).reverse();
  return [...owner.sort(newestFirst), ...dialogs, ...orchestrator.sort(newestFirst)];
};

/** What waits for the owner: open owner questions and pending dialogs. Questions to the orchestrator are not counted. */
export const countOpenDecisions = (overview: PiOrchestrationOverview): number => {
  let count = overview.dialogs.length;
  for (const group of overview.orchestrators) {
    for (const worker of group.workers) {
      if (worker.question?.audience === 'owner') count += 1;
    }
  }
  return count;
};

/** The last segment of a worktree or project path, for a short label. */
export const projectLabel = (path: string | null): string | null => {
  if (!path) return null;
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
};

type QuestionTarget = { sessionId: string; questionId: string };

type QuestionOutcome =
  | { status: 'sent'; resolved: boolean }
  | { status: 'closed' }
  | { status: 'failed'; message: string };

const failure = (error: unknown): QuestionOutcome => {
  if (error instanceof PiRequestError && error.code === 'ORCHESTRATION_QUESTION_UNKNOWN') return { status: 'closed' };
  return { status: 'failed', message: error instanceof Error ? error.message : String(error) };
};

/**
 * Sends the owner's answer as a prompt to the worker (the S3 route). The same
 * `clientRequestId` on a retry returns the first receipt instead of prompting
 * twice. A question that is no longer open is `closed`, not a failure.
 */
export const sendQuestionAnswer = async (
  target: QuestionTarget,
  text: string,
  clientRequestId: string,
  runtimeKey: string,
): Promise<QuestionOutcome> => {
  try {
    const response = await piClient.answerOrchestrationQuestion(target.sessionId, target.questionId, { text, clientRequestId }, { runtimeKey });
    return { status: 'sent', resolved: response.resolved };
  } catch (error) {
    return failure(error);
  }
};

/** Closes the question without a prompt, for an answer already given in the chat. */
export const markQuestionAnswered = async (target: QuestionTarget, runtimeKey: string): Promise<QuestionOutcome> => {
  try {
    await piClient.resolveOrchestrationQuestion(target.sessionId, target.questionId, { runtimeKey });
    return { status: 'sent', resolved: true };
  } catch (error) {
    return failure(error);
  }
};

type AnswerAction = 'answer' | 'resolve';

type AnswerDraft = {
  text: string;
  /** One id per answer attempt, kept across retries until the answer went through or the question closed. */
  requestId: string | null;
  pending: AnswerAction | null;
  notice: { tone: 'info' | 'error'; text: string } | null;
};

type AnswerDraftEvent =
  | { type: 'edit'; text: string }
  | { type: 'start'; action: AnswerAction; requestId: string | null }
  | { type: 'settled'; action: AnswerAction; outcome: QuestionOutcome };

export const EMPTY_ANSWER_DRAFT: AnswerDraft = { text: '', requestId: null, pending: null, notice: null };

export const answerDraftReducer = (draft: AnswerDraft, event: AnswerDraftEvent): AnswerDraft => {
  switch (event.type) {
    case 'edit':
      return { ...draft, text: event.text };
    case 'start':
      if (draft.pending) return draft;
      return {
        ...draft,
        pending: event.action,
        requestId: event.action === 'answer' ? (draft.requestId ?? event.requestId) : draft.requestId,
        notice: null,
      };
    case 'settled': {
      const { action, outcome } = event;
      if (outcome.status === 'failed') {
        const what = action === 'answer' ? 'Could not send the answer.' : 'Could not mark it answered.';
        return { ...draft, pending: null, notice: { tone: 'error', text: `${what} ${outcome.message}` } };
      }
      if (outcome.status === 'closed') {
        return { ...draft, pending: null, requestId: null, notice: { tone: 'info', text: 'This question is no longer open.' } };
      }
      if (action === 'resolve') {
        return { ...draft, pending: null, notice: { tone: 'info', text: 'Marked answered.' } };
      }
      return {
        text: '',
        requestId: null,
        pending: null,
        notice: {
          tone: 'info',
          text: outcome.resolved ? 'Answer sent.' : 'Answer sent. The worker replaced the question in the meantime.',
        },
      };
    }
  }
};

/** Answers a pending dialog through the same path as the in-session overlay, then rereads the overview. */
export const submitInboxDialog = async (
  item: Pick<InboxDialog, 'sessionId' | 'dialog'>,
  answer: DialogAnswer,
  onRefresh: () => void,
): Promise<boolean> => {
  try {
    await answerExtensionDialog(item.sessionId, item.dialog, answer);
  } catch {
    return false;
  }
  onRefresh();
  return true;
};
