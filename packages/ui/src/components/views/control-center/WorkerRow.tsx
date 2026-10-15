import React from 'react';
import type { PiOrchestrationWorker } from '@/lib/pi/protocol';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import {
  LIFECYCLE_LABEL,
  LIVE_LABEL,
  REPORT_LABEL,
  TONE_TEXT_CLASS,
  describeChecks,
  formatAge,
} from './format';

type Props = {
  worker: PiOrchestrationWorker;
  /** The overview's `at`; ages are measured against it. */
  now: number;
  onOpen: (worker: PiOrchestrationWorker) => void;
};

const PULL_REQUEST_STATUS_LABEL = { open: 'open', merged: 'merged', closed: 'closed' } as const;

/** One worker: what it is, how it is doing, and what it last said. Selecting it opens its session. */
export const WorkerRow = React.memo(function WorkerRow({ worker, now, onOpen }: Props): React.ReactElement {
  const title = worker.title?.trim() || worker.sessionId;
  const progressAge = formatAge(worker.lastProgressAt, now);
  const checks = describeChecks(worker.pullRequestStatus);
  const report = worker.report;
  const question = worker.question;
  const live = worker.live ? LIVE_LABEL[worker.live] : null;

  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(worker)}
        aria-label={`Open ${title}`}
        data-worker-id={worker.sessionId}
        className="flex w-full min-w-0 flex-col gap-1 rounded-md px-3 py-2 text-left hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
      >
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="min-w-0 truncate typography-ui-label font-medium text-foreground">{title}</span>
          {worker.issue ? (
            <span className="shrink-0 typography-micro text-muted-foreground" title={worker.issue.repo}>
              {`#${worker.issue.number}`}
            </span>
          ) : null}
          <span className="shrink-0 typography-micro text-muted-foreground">
            {live ? `${LIFECYCLE_LABEL[worker.lifecycle]} · ${live}` : LIFECYCLE_LABEL[worker.lifecycle]}
          </span>
          {progressAge ? (
            <span className="ml-auto shrink-0 typography-micro text-muted-foreground/75">{`progress ${progressAge}`}</span>
          ) : null}
        </span>

        {question ? (
          <span className="flex min-w-0 items-start gap-1.5 typography-micro text-foreground">
            <Icon name="question" className={cn('mt-px size-3.5 shrink-0', TONE_TEXT_CLASS[question.kind === 'blocked' ? 'error' : 'warning'])} />
            <span className="min-w-0">
              <span className={cn('font-medium', TONE_TEXT_CLASS[question.kind === 'blocked' ? 'error' : 'warning'])}>
                {question.kind === 'blocked' ? `Blocked, asks the ${question.audience}` : `Asks the ${question.audience}`}
              </span>
              {`: ${question.summary}`}
            </span>
          </span>
        ) : null}

        {report ? (
          <span className="min-w-0 truncate typography-micro text-muted-foreground" title={report.summary}>
            <span className="font-medium text-foreground/80">{REPORT_LABEL[report.kind]}</span>
            {` ${formatAge(report.at, now)}: ${report.summary}`}
          </span>
        ) : null}

        {worker.pullRequest ? (
          <span className="flex min-w-0 items-center gap-1.5 typography-micro text-muted-foreground">
            <Icon name="git-pull-request" className="size-3.5 shrink-0" />
            <span className="shrink-0">
              {worker.pullRequestStatus
                ? `#${worker.pullRequest.number} ${PULL_REQUEST_STATUS_LABEL[worker.pullRequestStatus.status]}`
                : `#${worker.pullRequest.number}`}
            </span>
            {checks ? <span className={cn('shrink-0', TONE_TEXT_CLASS[checks.tone])}>{checks.label}</span> : null}
          </span>
        ) : null}
      </button>
    </li>
  );
});
