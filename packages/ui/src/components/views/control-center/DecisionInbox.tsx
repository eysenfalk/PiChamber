import React from 'react';
import type { PiOrchestrationOverview } from '@/lib/pi/protocol';
import { collectInboxItems, countOpenDecisions } from './decisionInboxModel';
import { DecisionInboxDialog } from './DecisionInboxDialog';
import { DecisionInboxQuestion } from './DecisionInboxQuestion';
import { openWorkerSession } from './openWorkerSession';

type Props = {
  overview: PiOrchestrationOverview;
  /** The runtime the overview was read from; answers go to it. */
  runtimeKey: string;
  onRefresh: () => void;
};

/**
 * The decision inbox (#20, #87): every open worker question and every pending
 * extension dialog across sessions and projects. Answering here has the same
 * effect as answering in the session; afterwards the overview is reread.
 */
export function DecisionInbox({ overview, runtimeKey, onRefresh }: Props): React.ReactElement {
  const items = React.useMemo(() => collectInboxItems(overview), [overview]);
  const count = React.useMemo(() => countOpenDecisions(overview), [overview]);
  const now = overview.at;

  return (
    <section aria-label="Decision inbox" className="flex flex-col gap-2">
      <h2 className="flex items-baseline gap-2 typography-ui-label font-semibold text-foreground">
        {"Decisions"}
        <span className="typography-micro font-normal text-muted-foreground">
          {count === 0 ? "nothing waits for you" : count === 1 ? "1 waits for you" : `${count} wait for you`}
        </span>
      </h2>
      {items.length === 0 ? (
        <p className="typography-micro text-muted-foreground">{"No open questions or dialogs."}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((item) => item.kind === 'question' ? (
            <DecisionInboxQuestion
              key={item.key}
              item={item}
              now={now}
              runtimeKey={runtimeKey}
              onRefresh={onRefresh}
              onOpen={() => openWorkerSession({ sessionId: item.sessionId, worktree: item.worktree })}
            />
          ) : (
            <DecisionInboxDialog
              key={item.key}
              item={item}
              onRefresh={onRefresh}
              onOpen={() => openWorkerSession({ sessionId: item.sessionId, worktree: item.directory })}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
