import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { createBrowserUuid } from '@/lib/uuid';
import { cn } from '@/lib/utils';
import {
  EMPTY_ANSWER_DRAFT,
  answerDraftReducer,
  markQuestionAnswered,
  sendQuestionAnswer,
  type InboxQuestion,
} from './decisionInboxModel';
import { DecisionInboxContext } from './DecisionInboxContext';
import { TONE_TEXT_CLASS, formatAge } from './format';

type Props = {
  item: InboxQuestion;
  now: number;
  runtimeKey: string;
  onRefresh: () => void;
  onOpen: () => void;
};

/** One open worker question with its brief and an answer box. The caller keys it by question id. */
export function DecisionInboxQuestion({ item, now, runtimeKey, onRefresh, onOpen }: Props): React.ReactElement {
  const { question } = item;
  const [draft, dispatch] = React.useReducer(answerDraftReducer, EMPTY_ANSWER_DRAFT);
  const target = React.useMemo(() => ({ sessionId: item.sessionId, questionId: question.id }), [item.sessionId, question.id]);
  const forOrchestrator = question.audience === 'orchestrator';
  const tone = question.kind === 'blocked' ? 'error' : 'warning';
  const brief = question.brief;

  const sendAnswer = async () => {
    const text = draft.text.trim();
    if (!text || draft.pending) return;
    const requestId = draft.requestId ?? createBrowserUuid();
    dispatch({ type: 'start', action: 'answer', requestId });
    const outcome = await sendQuestionAnswer(target, text, requestId, runtimeKey);
    dispatch({ type: 'settled', action: 'answer', outcome });
    if (outcome.status !== 'failed') onRefresh();
  };

  const markAnswered = async () => {
    if (draft.pending) return;
    dispatch({ type: 'start', action: 'resolve', requestId: null });
    const outcome = await markQuestionAnswered(target, runtimeKey);
    dispatch({ type: 'settled', action: 'resolve', outcome });
    if (outcome.status !== 'failed') onRefresh();
  };

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border bg-[var(--surface-elevated)] p-3" data-inbox-question={question.id}>
      <DecisionInboxContext
        icon="question"
        iconClassName={TONE_TEXT_CLASS[tone]}
        label={question.kind === 'blocked' ? 'Blocked' : 'Question'}
        labelClassName={TONE_TEXT_CLASS[tone]}
        badge={forOrchestrator ? 'For the orchestrator' : null}
        age={formatAge(question.at, now)}
        title={item.title}
        path={item.worktree}
        onOpen={onOpen}
      />

      <p className="whitespace-pre-wrap typography-ui-label text-foreground">{question.summary}</p>

      {brief ? (
        <dl className="flex flex-col gap-1 typography-micro text-foreground">
          {brief.options && brief.options.length > 0 ? (
            <div>
              <dt className="font-medium text-muted-foreground">{"Options"}</dt>
              <dd>
                <ul className="list-disc pl-4">
                  {brief.options.map((option) => <li key={option}>{option}</li>)}
                </ul>
              </dd>
            </div>
          ) : null}
          <div>
            <dt className="font-medium text-muted-foreground">{"Recommendation"}</dt>
            <dd>{brief.recommendation}</dd>
          </div>
          {brief.counterargument ? (
            <div>
              <dt className="font-medium text-muted-foreground">{"Strongest counterargument"}</dt>
              <dd>{brief.counterargument}</dd>
            </div>
          ) : null}
          {brief.revisit ? (
            <div>
              <dt className="font-medium text-muted-foreground">{"Revisit when"}</dt>
              <dd>{brief.revisit}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      {forOrchestrator ? (
        <p className="typography-micro text-muted-foreground">{"The orchestrator usually answers this. An answer here goes to the worker as yours."}</p>
      ) : null}

      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void sendAnswer();
        }}
      >
        <textarea
          value={draft.text}
          onChange={(event) => dispatch({ type: 'edit', text: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void sendAnswer();
            }
          }}
          readOnly={draft.pending !== null}
          rows={2}
          aria-label={`Answer to ${item.title}`}
          placeholder={"Your answer for the worker"}
          className="w-full resize-y rounded-md border border-border bg-transparent p-2 typography-ui-label text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-focus"
        />
        <div className="flex flex-wrap items-center justify-end gap-2">
          {draft.notice ? (
            <p
              role={draft.notice.tone === 'error' ? 'alert' : 'status'}
              className={cn('mr-auto typography-micro', draft.notice.tone === 'error' ? 'text-[var(--status-error)]' : 'text-muted-foreground')}
            >
              {draft.notice.text}
            </p>
          ) : null}
          <Button type="button" variant="ghost" size="sm" onClick={() => void markAnswered()} disabled={draft.pending !== null}>
            {"Mark answered"}
          </Button>
          <Button type="submit" variant="default" size="sm" disabled={draft.pending !== null || draft.text.trim().length === 0}>
            {draft.pending === 'answer' ? <Icon name="loader-4" className="size-3.5 animate-spin" /> : null}
            {draft.requestId && draft.pending === null ? "Retry" : "Send answer"}
          </Button>
        </div>
      </form>
    </li>
  );
}
