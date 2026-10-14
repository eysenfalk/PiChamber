import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { resolvePiChamberDataDir } from '../../pichamber-data-dir.js';

// Pages live with the PiChamber data, one directory per Pi session, so a
// session shows its pages again after a reload or reconnect: the persisted
// tool result names the file.

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** Whether a value can name a session or render directory entry; rejects traversal. */
export const isHtmlRenderId = (value) => typeof value === 'string' && ID_PATTERN.test(value);

export const createHtmlRenderStore = ({ directory = join(resolvePiChamberDataDir(), 'pi', 'html-renders') } = {}) => {
  const fileFor = (sessionId, renderId) => {
    if (!isHtmlRenderId(sessionId) || !isHtmlRenderId(renderId)) return null;
    return join(directory, sessionId, `${renderId}.html`);
  };

  return {
    /** Stores a prepared page for a session and returns its new render id. */
    async save(sessionId, html) {
      if (!isHtmlRenderId(sessionId)) throw new Error('The HTML render could not be saved: invalid session id.');
      const renderId = randomUUID();
      const file = fileFor(sessionId, renderId);
      await mkdir(join(directory, sessionId), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${process.pid}.tmp`;
      await writeFile(temporary, html, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, file);
      return renderId;
    },
    /** The stored page, or null when the ids are invalid or nothing is stored. */
    async read(sessionId, renderId) {
      const file = fileFor(sessionId, renderId);
      if (!file) return null;
      try {
        return await readFile(file);
      } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
        throw error;
      }
    },
  };
};
