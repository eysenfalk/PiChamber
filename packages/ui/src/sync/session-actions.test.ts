import { afterEach, describe, expect, test } from 'bun:test';
import { getPiSessionStore } from '@/apps/pi-session-store';
import { PiRequestError, piClient } from '@/lib/pi/client';
import * as sessionActions from './session-actions';

describe('session-actions Pi shims', () => {
  test('waitForConnectionOrThrow succeeds when the Pi store is ready', async () => {
    getPiSessionStore().clear();
    await sessionActions.waitForConnectionOrThrow();
  });
});

describe('session-actions archive failures', () => {
  const original = piClient.archiveSession.bind(piClient);
  afterEach(() => {
    piClient.archiveSession = original;
  });

  test('a rejected archive is reported as failed, not thrown, and archives nothing', async () => {
    piClient.archiveSession = (async () => {
      throw new PiRequestError('SESSION_JSONL_UNREADABLE', 'unreadable', 503);
    }) as typeof piClient.archiveSession;

    await expect(sessionActions.archiveSession('broken')).resolves.toBe(false);
    await expect(sessionActions.archiveSessions(['broken'])).resolves.toEqual({ archivedIds: [], failedIds: ['broken'] });
  });

  test('one failed archive does not block the others', async () => {
    piClient.archiveSession = (async (input: { sessionId: string }) => {
      if (input.sessionId === 'broken') throw new PiRequestError('SESSION_JSONL_UNREADABLE', 'unreadable', 503);
      return undefined;
    }) as typeof piClient.archiveSession;

    await expect(sessionActions.archiveSessions(['a', 'broken', 'b'])).resolves.toEqual({
      archivedIds: ['a', 'b'],
      failedIds: ['broken'],
    });
  });
});
