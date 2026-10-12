import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

// Finds the persisted session a start operation created, after the process
// that created it is gone. Only the sessions of the operation's directory are
// read, and of each only the entries before its first message: the lineage
// entry is written when the session is created, before any prompt.

// The lineage opId of one session file; undefined when its prefix has none,
// UNREADABLE when an entry of the prefix could not be parsed and may have been it.
const UNREADABLE = Symbol('unreadable');

const lineageOpIdOf = async (file, lineageType) => {
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  let unreadable = false;
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        unreadable = true;
        continue;
      }
      if (entry?.type === 'message') break;
      if (entry?.type === 'custom' && entry.customType === lineageType && typeof entry.data?.opId === 'string') {
        return entry.data.opId;
      }
    }
    return unreadable ? UNREADABLE : undefined;
  } finally {
    lines.close();
  }
};

/**
 * The persisted session whose lineage names `opId`, or undefined after every
 * session of `cwd` was read. A session file removed since the listing is
 * skipped. A failed read, or a prefix entry that cannot be parsed, does not
 * stop the scan; when no session matched it throws SESSION_LOOKUP_FAILED
 * (incomplete), so the caller cannot take it for a negative answer.
 */
export const findPersistedSessionByOperation = async ({ opId, cwd, listSessions, lineageType }) => {
  const sessions = await listSessions({ cwd });
  const unreadable = [];
  for (const session of Array.isArray(sessions) ? sessions : []) {
    if (typeof session?.path !== 'string' || typeof session.id !== 'string') continue;
    let found;
    try {
      found = await lineageOpIdOf(session.path, lineageType);
    } catch (error) {
      // Removed between listing and reading: not this operation's session.
      // Any other failure may hide it, but must not stop the other files.
      if (error?.code !== 'ENOENT') unreadable.push(session.id);
      continue;
    }
    if (found === opId) return { sessionId: session.id, cwd, sessionFile: session.path };
    if (found === UNREADABLE) unreadable.push(session.id);
  }
  if (unreadable.length > 0) {
    throw Object.assign(new Error('Some sessions could not be read to find the start operation.'), {
      code: 'SESSION_LOOKUP_FAILED',
      incomplete: true,
      sessionIds: unreadable,
    });
  }
  return undefined;
};
