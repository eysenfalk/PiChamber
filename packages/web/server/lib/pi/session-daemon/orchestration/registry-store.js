import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { withCrossProcessLock } from '../../../server/cross-process-lock.js';

// Durable orchestration registry: which orchestrator owns which worker, start
// operations with their reservations, and the bookkeeping later slices add.
// One JSON file beside the other PiChamber stores, replaced atomically under
// the per-file cross-process lock. `update` is the only write path: it reads
// the current document, lets the caller change it and writes it back, all
// inside one serialised critical section. Unknown keys survive a write.

const REGISTRY_VERSION = 1;

class RegistryInvalidError extends Error {
  constructor() {
    super('The orchestration registry is invalid.');
    this.name = 'RegistryInvalidError';
    this.code = 'ORCHESTRATION_REGISTRY_INVALID';
  }
}

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const RECORD_FIELDS = ['owners', 'requestKeys', 'operations', 'workers', 'pendingEvents'];

const normalize = (parsed) => {
  if (!isRecord(parsed)) throw new RegistryInvalidError();
  if (parsed.version !== undefined && parsed.version !== REGISTRY_VERSION) throw new RegistryInvalidError();
  const document = { ...parsed, version: REGISTRY_VERSION };
  if (document.importedFromLineage === undefined) document.importedFromLineage = [];
  if (!Array.isArray(document.importedFromLineage)) throw new RegistryInvalidError();
  for (const field of RECORD_FIELDS) {
    if (document[field] === undefined) document[field] = {};
    if (!isRecord(document[field])) throw new RegistryInvalidError();
  }
  return document;
};

const emptyRegistry = () => normalize({});

/**
 * @param {{ file: string }} options absolute path of the registry file.
 */
export const createOrchestrationRegistryStore = ({ file }) => {
  let writeChain = Promise.resolve();

  // A missing file is an empty registry; a malformed one fails instead of
  // being treated as empty, which would silently drop every reservation.
  const read = async () => {
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return emptyRegistry();
      throw error;
    }
    try {
      return normalize(JSON.parse(text));
    } catch {
      throw new RegistryInvalidError();
    }
  };

  /**
   * Serialised read, change, write. `change(document)` mutates the document
   * and returns the call's result; a throw leaves the file untouched.
   */
  const update = (change) => {
    const operation = writeChain.then(() => withCrossProcessLock(`${file}.lock`, async () => {
      const document = await read();
      const result = await change(document);
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.tmp`;
      await writeFile(temporary, JSON.stringify(document), { mode: 0o600 });
      await rename(temporary, file);
      return result;
    }));
    writeChain = operation.catch(() => {});
    return operation;
  };

  return { read, update };
};
