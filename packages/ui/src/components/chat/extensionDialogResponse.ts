import { getPiSessionStore } from '@/apps/pi-session-store';
import type { PiExtensionDialogPayload } from '@/lib/pi/protocol';
import { PiRequestError, piClient } from '@/lib/pi/client';
import { getRuntimeKey } from '@/lib/runtime-switch';

/**
 * Answers a blocking pi extension dialog. Shared by the in-session overlay and
 * the control center's decision inbox, so both have the same effect: the
 * daemon resumes the extension and the local store drops the dialog. A dialog
 * that is no longer pending counts as answered.
 */

export type DialogAnswer = {
  cancelled?: boolean;
  confirmed?: boolean;
  value?: string;
  values?: Record<string, string>;
};

export const answerExtensionDialog = async (
  sessionId: string,
  request: PiExtensionDialogPayload,
  answer: DialogAnswer,
): Promise<void> => {
  try {
    await piClient.respondToExtensionDialog(
      { requestId: request.requestId, ...answer },
      { runtimeKey: getRuntimeKey() },
    );
    // The daemon also publishes extension.dialog.dismiss for every connected
    // client. Apply the successful response locally so the answering client
    // does not wait for the stream round trip.
    getPiSessionStore().dismissExtensionDialog(sessionId, request.requestId);
  } catch (error) {
    if (error instanceof PiRequestError && error.code === 'EXTENSION_DIALOG_NOT_PENDING') {
      getPiSessionStore().dismissExtensionDialog(sessionId, request.requestId);
      return;
    }
    throw error;
  }
};
