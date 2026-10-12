import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

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

  it('ignores a lineage entry after the first message and sessions removed since the listing', async () => {
    const sessions = await sessionsIn({
      late: jsonl({ type: 'session' }, { type: 'message' }, { type: 'custom', customType: LINEAGE, data: { opId: 'op_1' } }),
      removed: null,
    });
    await expect(lookup(sessions)).resolves.toBeUndefined();
  });

  it('fails instead of answering "not found" when a session cannot be read', async () => {
    await expect(lookup([{ id: 'dir', path: tmpdir() }])).rejects.toMatchObject({ code: 'EISDIR' });
  });
});
