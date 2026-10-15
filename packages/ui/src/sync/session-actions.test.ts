import { afterEach, describe, expect, test } from 'bun:test';
import { getPiSessionStore } from '@/apps/pi-session-store';
import * as sessionActions from './session-actions';

describe('session-actions Pi shims', () => {
  test('waitForConnectionOrThrow succeeds when the Pi store is ready', async () => {
    getPiSessionStore().clear();
    await sessionActions.waitForConnectionOrThrow();
  });
});

describe('session-actions archive failures', () => {
  const store = getPiSessionStore();
  const original = store.archive.bind(store);
  afterEach(() => {
    store.archive = original;
  });

  test('a rejected archive is reported as failed, not thrown', async () => {
    store.archive = (async () => {
      throw new Error('SESSION_JSONL_UNREADABLE');
    }) as typeof store.archive;

    expect(await sessionActions.archiveSession('broken')).toBe(false);
    expect(await sessionActions.archiveSessions(['broken'])).toEqual({ archivedIds: [], failedIds: ['broken'] });
  });

  test('one failed archive does not block the others', async () => {
    const archived: string[] = [];
    store.archive = (async (id: string) => {
      if (id === 'broken') throw new Error('SESSION_JSONL_UNREADABLE');
      archived.push(id);
    }) as typeof store.archive;

    expect(await sessionActions.archiveSessions(['a', 'broken', 'b'])).toEqual({
      archivedIds: ['a', 'b'],
      failedIds: ['broken'],
    });
    expect(archived).toEqual(['a', 'b']);
  });
});
