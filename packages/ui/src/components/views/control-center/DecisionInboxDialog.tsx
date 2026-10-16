import React from 'react';
import { ExtensionDialogBody } from '@/components/chat/ExtensionDialogBody';
import type { DialogAnswer } from '@/components/chat/extensionDialogResponse';
import { stripAnsi } from '@/lib/pi/ansi';
import { submitInboxDialog, type InboxDialog } from './decisionInboxModel';
import { DecisionInboxContext } from './DecisionInboxContext';

type Props = {
  item: InboxDialog;
  onRefresh: () => void;
  onOpen: () => void;
};

/** One pending extension dialog, answered with the same controls and path as the in-session overlay. */
export function DecisionInboxDialog({ item, onRefresh, onOpen }: Props): React.ReactElement {
  const [responding, setResponding] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  const respond = React.useCallback((answer: DialogAnswer) => {
    if (responding) return;
    setResponding(true);
    setFailed(false);
    void submitInboxDialog(item, answer, onRefresh).then((ok) => {
      setResponding(false);
      setFailed(!ok);
    });
  }, [item, onRefresh, responding]);

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border bg-[var(--surface-elevated)] p-3" data-inbox-dialog={item.dialog.requestId}>
      <DecisionInboxContext
        icon="notification-3"
        iconClassName="text-[var(--status-warning)]"
        label={"Dialog"}
        labelClassName="text-[var(--status-warning)]"
        badge={null}
        age={null}
        title={item.title}
        path={item.directory}
        onOpen={onOpen}
      />
      <h3 className="typography-ui-label font-semibold text-foreground">{stripAnsi(item.dialog.title)}</h3>
      <div className={responding ? 'pointer-events-none opacity-60' : undefined} aria-busy={responding || undefined}>
        <ExtensionDialogBody key={item.dialog.requestId} request={item.dialog} onRespond={respond} autoFocus={false} />
      </div>
      {failed ? (
        <p role="alert" className="typography-micro text-[var(--status-error)]">
          {"Could not send the response. Check your connection and try again."}
        </p>
      ) : null}
    </li>
  );
}
