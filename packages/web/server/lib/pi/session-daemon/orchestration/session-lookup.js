import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

// Finds the persisted session a start operation created, after the process
// that created it is gone. Only the sessions of the operation's directory are
// read, and of each only the entries before its first message: the lineage
// entry is written when the session is created, before any prompt.

const lineageOpIdOf = async (file, lineageType) => {
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry?.type === 'message') return undefined;
      if (entry?.type === 'custom' && entry.customType === lineageType && typeof entry.data?.opId === 'string') {
        return entry.data.opId;
      }
    }
    return undefined;
  } finally {
    lines.close();
  }
};

/**
 * The persisted session whose lineage names `opId`, or undefined after every
 * session of `cwd` was read. A failed read throws, so the caller cannot take
 * an unreadable store for a negative answer.
 */
export const findPersistedSessionByOperation = async ({ opId, cwd, listSessions, lineageType }) => {
  const sessions = await listSessions({ cwd });
  for (const session of Array.isArray(sessions) ? sessions : []) {
    if (typeof session?.path !== 'string' || typeof session.id !== 'string') continue;
    let found;
    try {
      found = await lineageOpIdOf(session.path, lineageType);
    } catch (error) {
      // Removed between listing and reading: not this operation's session.
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (found === opId) return { sessionId: session.id, cwd, sessionFile: session.path };
  }
  return undefined;
};
