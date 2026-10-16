import React from 'react';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { cn } from '@/lib/utils';
import { projectLabel } from './decisionInboxModel';

type Props = {
  icon: IconName;
  iconClassName: string;
  label: string;
  labelClassName: string;
  badge: string | null;
  age: string | null;
  /** Session title. */
  title: string;
  /** Worktree or project directory. */
  path: string | null;
  onOpen: () => void;
};

/** The head of an inbox entry: what kind of decision, which session and project, and a way into the session. */
export function DecisionInboxContext({ icon, iconClassName, label, labelClassName, badge, age, title, path, onOpen }: Props): React.ReactElement {
  const project = projectLabel(path);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 typography-micro">
      <Icon name={icon} className={cn('size-3.5 shrink-0', iconClassName)} />
      <span className={cn('shrink-0 font-medium', labelClassName)}>{label}</span>
      {badge ? (
        <span className="shrink-0 rounded-sm border border-border px-1 text-muted-foreground">{badge}</span>
      ) : null}
      <span className="min-w-0 truncate font-medium text-foreground">{title}</span>
      {project ? (
        <span className="min-w-0 truncate text-muted-foreground" title={path ?? undefined}>{project}</span>
      ) : null}
      {age ? <span className="shrink-0 text-muted-foreground/75">{age}</span> : null}
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open session ${title}`}
        className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
      >
        <Icon name="external-link" className="size-3.5" />
        {"Open session"}
      </button>
    </div>
  );
}
