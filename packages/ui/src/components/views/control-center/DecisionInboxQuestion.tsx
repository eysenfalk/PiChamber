import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { openExternalUrl } from '@/lib/url';
import { createBrowserUuid } from '@/lib/uuid';
import { cn } from '@/lib/utils';
import {
  EMPTY_ANSWER_DRAFT,
  answerAttempt,
  answerDraftReducer,
  briefOptions,
  markQuestionAnswered,
  optionAnswerText,
  sendQuestionAnswer,
  type InboxLink,
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

function BriefEntry({ term, children }: { term: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div>
      <dt className="font-medium text-muted-foreground">{term}</dt>
      <dd className="whitespace-pre-wrap">{children}</dd>
    </div>
  );
}

function WorkLink({ link }: { link: InboxLink }): React.ReactElement {
  if (!link.url) return <span>{link.label}</span>;
  const url = link.url;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => {
        event.preventDefault();
        void openExternalUrl(url);
      }}
      className="rounded-sm underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
    >
      {link.label}
    </a>
  );
}

/**
 * One open worker question with its brief and an answer box. The caller keys
 * it by question id. A tap on an option sends that option at once, with the
 * typed note when there is one (owner decision on #210: no confirmation step).
 */
export function DecisionInboxQuestion({ item, now, runtimeKey, onRefresh, onOpen }: Props): React.ReactElement {
  const { question } = item;
  const [draft, dispatch] = React.useReducer(answerDraftReducer, EMPTY_ANSWER_DRAFT);
  const [choice, setChoice] = React.useState<string | null>(null);
  const target = React.useMemo(() => ({ sessionId: item.sessionId, questionId: question.id }), [item.sessionId, question.id]);
  const forOrchestrator = question.audience === 'orchestrator';
  const blocked = question.kind === 'blocked';
  const tone = blocked ? 'error' : 'warning';
  const brief = question.brief;
  const options = briefOptions(brief);

  const send = async (text: string, chosen: string | null) => {
    if (!text || draft.pending) return;
    const attempt = answerAttempt(draft.attempt, text, createBrowserUuid);
    setChoice(chosen);
    dispatch({ type: 'start', action: 'answer', attempt });
    const outcome = await sendQuestionAnswer(target, text, attempt.id, runtimeKey);
    dispatch({ type: 'settled', action: 'answer', outcome });
    if (outcome.status !== 'failed') onRefresh();
  };

  const sendAnswer = () => send(draft.text.trim(), null);
  const sendOption = (label: string) => send(optionAnswerText(label, draft.text), label);

  const markAnswered = async () => {
    if (draft.pending) return;
    dispatch({ type: 'start', action: 'resolve' });
    const outcome = await markQuestionAnswered(target, runtimeKey);
    dispatch({ type: 'settled', action: 'resolve', outcome });
    if (outcome.status !== 'failed') onRefresh();
  };

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border bg-[var(--surface-elevated)] p-3" data-inbox-question={question.id}>
      <DecisionInboxContext
        icon="question"
        iconClassName={TONE_TEXT_CLASS[tone]}
        label={blocked ? 'Blocked' : 'Question'}
        labelClassName={TONE_TEXT_CLASS[tone]}
        badge={forOrchestrator ? 'For the orchestrator' : null}
        age={formatAge(question.at, now)}
        title={item.title}
        path={item.worktree}
        onOpen={onOpen}
      />

      <h3 className="whitespace-pre-wrap typography-ui-label font-semibold text-foreground">{question.summary}</h3>

      {item.links.length > 0 ? (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 typography-micro text-muted-foreground">
          {item.links.map((link) => <WorkLink key={link.label} link={link} />)}
        </p>
      ) : null}

      {brief?.context ? <p className="whitespace-pre-wrap typography-micro text-foreground">{brief.context}</p> : null}

      {brief && (brief.tried || brief.needed) ? (
        <dl className="flex flex-col gap-1 typography-micro text-foreground">
          {brief.tried ? <BriefEntry term={"Tried"}>{brief.tried}</BriefEntry> : null}
          {brief.needed ? <BriefEntry term={"Needed"}>{brief.needed}</BriefEntry> : null}
        </dl>
      ) : null}

      {options.length > 0 ? (
        <div role="group" aria-label={"Answer with an option"} className="flex flex-col gap-1.5">
          {options.map((option, index) => (
            <Button
              key={`${index}:${option.label}`}
              type="button"
              variant={option.recommended ? 'default' : 'outline'}
              size="sm"
              data-inbox-option={option.label}
              onClick={() => void sendOption(option.label)}
              disabled={draft.pending !== null}
              // An option carries its consequence, so the button grows with the text instead of a fixed height.
              className="h-auto min-h-8 w-full flex-col items-start gap-0.5 whitespace-normal py-1.5 text-left"
            >
              <span className="flex w-full items-center gap-2 font-medium">
                {draft.pending === 'answer' && choice === option.label ? <Icon name="loader-4" className="size-3.5 shrink-0 animate-spin" /> : null}
                <span className="min-w-0">{option.label}</span>
                {option.recommended ? <span className="ml-auto shrink-0 typography-micro font-normal">{"Recommended"}</span> : null}
              </span>
              {option.consequence ? <span className="typography-micro font-normal text-muted-foreground">{option.consequence}</span> : null}
            </Button>
          ))}
        </div>
      ) : null}

      {brief ? (
        <dl className="flex flex-col gap-1 typography-micro text-foreground">
          <BriefEntry term={"Recommendation"}>{brief.recommendation}</BriefEntry>
          {brief.counterargument ? <BriefEntry term={"Strongest counterargument"}>{brief.counterargument}</BriefEntry> : null}
          {brief.revisit ? <BriefEntry term={"Revisit when"}>{brief.revisit}</BriefEntry> : null}
        </dl>
      ) : null}

      {brief?.meanwhile ? (
        <p className="whitespace-pre-wrap rounded-md border border-border px-2 py-1.5 typography-micro text-foreground">
          <span className="font-medium text-muted-foreground">{"Until then: "}</span>
          {brief.meanwhile}
        </p>
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
          placeholder={options.length > 0 ? "Your answer, or a note sent with the option you tap" : "Your answer for the worker"}
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
            {draft.pending === 'answer' && choice === null ? <Icon name="loader-4" className="size-3.5 animate-spin" /> : null}
            {draft.attempt?.text === draft.text.trim() && draft.pending === null && choice === null ? "Retry" : "Send answer"}
          </Button>
        </div>
      </form>
    </li>
  );
}
