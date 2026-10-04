import { mkdtemp, open, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { findLatestSessionInfoBackward, findLatestSessionInfoForward } from './session-info-scan.js';

const CHUNK = 256 * 1024;

const withFile = async (text, scan) => {
  const root = await mkdtemp(join(tmpdir(), 'pichamber-session-info-scan-'));
  const file = join(root, 'session.jsonl');
  await writeFile(file, text);
  const handle = await open(file, 'r');
  try {
    return await scan(handle, Buffer.byteLength(text));
  } finally {
    await handle.close();
  }
};

const line = (entry) => `${JSON.stringify(entry)}\n`;
const filler = (bytes) => line({ type: 'message', content: 'é'.repeat(Math.max(0, Math.floor((bytes - 40) / 2))) });

describe('session_info scans', () => {
  it('finds a rename whose line spans a chunk boundary and keeps multibyte names intact', async () => {
    const rename = line({ type: 'session_info', name: 'Größe über Grenzen' });
    const head = filler(CHUNK - 20);
    const text = head + rename + filler(CHUNK + 1000);
    const forward = await withFile(text, (handle, size) => findLatestSessionInfoForward(handle, { start: 0, end: size }));
    expect(forward).toEqual({ entry: { type: 'session_info', name: 'Größe über Grenzen' }, completeEnd: Buffer.byteLength(text) });

    const tailText = filler(1000) + rename + filler(CHUNK - 10);
    const backward = await withFile(tailText, (handle, size) => findLatestSessionInfoBackward(handle, { start: 0, end: size }));
    expect(backward).toEqual({ entry: { type: 'session_info', name: 'Größe über Grenzen' }, completeEnd: Buffer.byteLength(tailText) });
  });

  it('reads a line longer than one chunk', async () => {
    const rename = line({ type: 'session_info', name: 'Long', note: 'n'.repeat(3 * CHUNK) });
    const text = filler(100) + rename + filler(100);
    const backward = await withFile(text, (handle, size) => findLatestSessionInfoBackward(handle, { start: 0, end: size }));
    expect(backward.entry?.name).toBe('Long');
    const forward = await withFile(text, (handle, size) => findLatestSessionInfoForward(handle, { start: 0, end: size }));
    expect(forward.entry?.name).toBe('Long');
  });

  it('returns the latest rename and ignores escaped mentions and other entry types', async () => {
    const text = line({ type: 'session_info', name: 'First' })
      + line({ type: 'session_info', name: 'Second' })
      + line({ type: 'message', content: 'about "session_info" entries' })
      + line({ type: 'custom', kind: 'session_info' });
    const backward = await withFile(text, (handle, size) => findLatestSessionInfoBackward(handle, { start: 0, end: size }));
    expect(backward.entry?.name).toBe('Second');
    const forward = await withFile(text, (handle, size) => findLatestSessionInfoForward(handle, { start: 0, end: size }));
    expect(forward.entry?.name).toBe('Second');
  });

  it('reports the end of the last complete line when the file ends mid-line', async () => {
    const complete = line({ type: 'session_info', name: 'Done' });
    const text = complete + '{"type":"session_info","na';
    const backward = await withFile(text, (handle, size) => findLatestSessionInfoBackward(handle, { start: 0, end: size }));
    expect(backward).toEqual({ entry: { type: 'session_info', name: 'Done' }, completeEnd: Buffer.byteLength(complete) });
    const forward = await withFile(text, (handle, size) => findLatestSessionInfoForward(handle, { start: 0, end: size }));
    expect(forward).toEqual({ entry: { type: 'session_info', name: 'Done' }, completeEnd: Buffer.byteLength(complete) });
  });

  it('finds nothing in a range without renames', async () => {
    const text = filler(CHUNK * 2);
    const backward = await withFile(text, (handle, size) => findLatestSessionInfoBackward(handle, { start: 0, end: size }));
    expect(backward).toEqual({ entry: undefined, completeEnd: Buffer.byteLength(text) });
    const empty = await withFile('', (handle) => findLatestSessionInfoForward(handle, { start: 0, end: 0 }));
    expect(empty).toEqual({ entry: undefined, completeEnd: 0 });
  });
});
