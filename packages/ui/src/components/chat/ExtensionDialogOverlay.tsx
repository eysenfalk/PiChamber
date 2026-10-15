import * as React from 'react';

import { usePiSessionSnapshot } from '@/sync/pi-session-context';
import { stripAnsi } from '@/lib/pi/ansi';
import { ExtensionDialogBody } from './ExtensionDialogBody';
import { answerExtensionDialog, type DialogAnswer } from './extensionDialogResponse';

/**
 * Blocking pi extension dialogs (ctx.ui.select / confirm / input / editor).
 * The extension runtime stays suspended until the user answers, so pending
 * dialogs render as a modal overlay for the open session only. Dialogs of
 * other sessions stay pending in the store and show in their own chat.
 */

const DialogFrame: React.FC<{
  title: string;
  children: React.ReactNode;
  onRequestCancel: () => void;
}> = ({ title, children, onRequestCancel }) => {
  const dialogRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.contains(document.activeElement)) dialog.focus();
  }, []);

  return (
    <div className="pointer-events-auto fixed inset-0 z-50 flex items-end justify-center bg-black/40 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:items-center sm:py-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={stripAnsi(title)}
        className="max-h-[calc(100dvh-max(2rem,env(safe-area-inset-bottom)))] w-full max-w-md overflow-y-auto overscroll-contain rounded-xl border bg-card p-4 text-card-foreground shadow-lg"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onRequestCancel();
            return;
          }
          if (event.key !== 'Tab') return;
          const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
          );
          if (!focusable || focusable.length === 0) {
            event.preventDefault();
            return;
          }
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
        tabIndex={-1}
      >
        <h2 className="mb-2 text-sm font-semibold">{stripAnsi(title)}</h2>
        {children}
      </div>
    </div>
  );
};

interface ExtensionDialogOverlayProps {
  /** Defaults to the store's selected session when omitted; null shows nothing. */
  sessionId?: string | null;
}

export const ExtensionDialogOverlay: React.FC<ExtensionDialogOverlayProps> = ({ sessionId }) => {
  const target = usePiSessionSnapshot(
    (state) => {
      const openSessionId = sessionId === undefined ? state.selectedSessionId : sessionId;
      const request = openSessionId
        ? state.reducer.bySession.get(openSessionId)?.extensionDialogs[0]
        : undefined;
      return openSessionId && request ? { sessionId: openSessionId, request } : null;
    },
    (a, b) => a?.sessionId === b?.sessionId && a?.request.requestId === b?.request.requestId,
    'dialogs',
  );
  const [responding, setResponding] = React.useState(false);
  const [responseError, setResponseError] = React.useState(false);

  React.useEffect(() => {
    setResponding(false);
    setResponseError(false);
  }, [target?.sessionId, target?.request.requestId]);

  const submit = React.useCallback((answer: DialogAnswer) => {
    if (!target || responding) return;
    setResponding(true);
    setResponseError(false);
    void answerExtensionDialog(target.sessionId, target.request, answer).catch(() => {
      setResponseError(true);
    }).finally(() => {
      setResponding(false);
    });
  }, [responding, target]);

  if (!target) return null;

  return (
    <DialogFrame
      title={target.request.title}
      onRequestCancel={() => submit({ cancelled: true })}
    >
      <div className={responding ? 'pointer-events-none opacity-60' : undefined} aria-busy={responding || undefined}>
        <ExtensionDialogBody key={target.request.requestId} request={target.request} onRespond={submit} />
      </div>
      {responseError && (
        <p role="alert" className="mt-2 text-xs text-status-error">
          Could not send the response. Check your connection and try again.
        </p>
      )}
    </DialogFrame>
  );
};
