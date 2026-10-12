import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { findPersistedSessionByOperation } from './session-lookup.js';

const LINEAGE = 'pichamber.orchestration.lineage';

const jsonl = (...entries) => `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;

const sessionsIn = async (files) => {
  const dir = await mkdtemp(join(tmpdir(), 'pichamber-session-lookup-'));
  const sessions = [];
  for (const [id, text] of Object.entries(files)) {
    const path = join(dir, `${id}.jsonl`);
    if (text !== null) await writeFile(path, text);
    sessions.push({ id, path });
  }
  return sessions;
};

const lookup = (sessions, opId = 'op_1') => findPersistedSessionByOperation({
  opId,
  cwd: '/work/a',
  listSessions: async ({ cwd }) => (cwd === '/work/a' ? sessions : []),
  lineageType: LINEAGE,
});

describe('persisted session lookup by start operation', () => {
  it('finds the session whose lineage names the operation', async () => {
    const sessions = await sessionsIn({
      other: jsonl({ type: 'session', id: 'other' }, { type: 'custom', customType: LINEAGE, data: { opId: 'op_2' } }),
      plain: jsonl({ type: 'session', id: 'plain' }, { type: 'message', message: { role: 'user' } }),
      target: jsonl({ type: 'session', id: 'target' }, { type: 'custom', customType: LINEAGE, data: { opId: 'op_1' } }, { type: 'message' }),
    });
    await expect(lookup(sessions)).resolves.toEqual({ sessionId: 'target', cwd: '/work/a', sessionFile: sessions[2].path });
  });

  it.skipIf(!existsSync('/proc/self/fd'))('closes every session file it read, also after an early match', async () => {
    // Larger than the read stream buffer, so a file is never read to its end.
    const body = `${JSON.stringify({ type: 'message', text: 'x'.repeat(1024) })}\n`.repeat(256);
    const sessions = await sessionsIn({
      other: `${jsonl({ type: 'session', id: 'other' })}${body}`,
      target: `${jsonl({ type: 'session', id: 'target' }, { type: 'custom', customType: LINEAGE, data: { opId: 'op_1' } })}${body}`,
    });
    const openFiles = () => readdirSync('/proc/self/fd').length;
    const before = openFiles();
    for (let scan = 0; scan < 20; scan += 1) {
      await expect(lookup(sessions)).resolves.toMatchObject({ sessionId: 'target' });
    }
    await vi.waitFor(() => expect(openFiles()).toBeLessThan(before + 5));
  });

  it('ignores a lineage entry after the first message and sessions removed since the listing', async () => {
    const sessions = await sessionsIn({
      late: jsonl({ type: 'session' }, { type: 'message' }, { type: 'custom', customType: LINEAGE, data: { opId: 'op_1' } }),
      removed: null,
    });
    await expect(lookup(sessions)).resolves.toBeUndefined();
  });

  it('fails instead of answering "not found" when an entry before the first message cannot be parsed', async () => {
    const lineage = JSON.stringify({ type: 'custom', customType: LINEAGE, data: { opId: 'op_1' } });
    const header = JSON.stringify({ type: 'session' });
    const user = JSON.stringify({ type: 'message', message: { role: 'user' } });
    const sessions = await sessionsIn({ broken: `${header}\n${lineage.slice(0, -6)}\n${user}\n` });
    await expect(lookup(sessions)).rejects.toMatchObject({ code: 'SESSION_LOOKUP_FAILED', incomplete: true });
    // A match elsewhere is still an answer.
    const both = await sessionsIn({
      broken: `${header}\n${lineage.slice(0, -6)}\n`,
      target: jsonl({ type: 'session' }, { type: 'custom', customType: LINEAGE, data: { opId: 'op_1' } }),
    });
    await expect(lookup(both)).resolves.toMatchObject({ sessionId: 'target' });
    await writeFile(sessions[0].path, `${header}\n${lineage}\n${user}\n`);
    await expect(lookup(sessions)).resolves.toMatchObject({ sessionId: 'broken' });
  });

  it('fails instead of answering "not found" when a session cannot be read, after checking the others', async () => {
    await expect(lookup([{ id: 'dir', path: tmpdir() }])).rejects.toMatchObject({ code: 'SESSION_LOOKUP_FAILED', incomplete: true });
    const [target] = await sessionsIn({
      target: jsonl({ type: 'session' }, { type: 'custom', customType: LINEAGE, data: { opId: 'op_1' } }),
    });
    await expect(lookup([{ id: 'dir', path: tmpdir() }, target])).resolves.toMatchObject({ sessionId: 'target' });
  });
});
