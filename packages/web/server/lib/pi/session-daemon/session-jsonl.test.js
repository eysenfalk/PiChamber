import { existsSync, readdirSync } from 'node:fs';
import { appendFile, chmod, mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createPiSessionListCache,
  encodePiSessionCwd,
  findPiSessionJsonlById,
  getPiSessionDirectory,
  listPiSessionJsonlDirectory,
  matchesPiSessionJsonlName,
  normalizeWindowsShellPath,
  scanPiSessionJsonlHeaders,
  validatePiSessionJsonlDirectory,
  validatePiSessionJsonlFile,
} from './session-jsonl.js';

const validHeader = (cwd) => JSON.stringify({
  type: 'session',
  version: 3,
  id: 'session-one',
  timestamp: '2026-01-01T00:00:00.000Z',
  cwd,
});

describe('Pi session header scan', () => {
  const store = async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'pichamber-pi-header-scan-'));
    const storeA = join(agentDir, 'sessions', 'a');
    const storeB = join(agentDir, 'sessions', 'b');
    await mkdir(storeA, { recursive: true });
    await mkdir(storeB, { recursive: true });
    await writeFile(join(storeB, 'renamed.jsonl'), `${JSON.stringify({ type: 'session', id: 'caller', cwd: '/work/b' })}\n`);
    return { agentDir, storeA };
  };

  it('goes on with the other stores when one vanished during the scan', async () => {
    const { agentDir, storeA } = await store();
    const readDirectory = async (path, options) => {
      if (path === storeA) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      const entries = await readdir(path, options);
      return path === join(agentDir, 'sessions') ? entries.sort((x, y) => x.name.localeCompare(y.name)) : entries;
    };
    await expect(scanPiSessionJsonlHeaders({ sessionId: 'caller', agentDir, readDirectory }))
      .resolves.toEqual({ match: { path: join(agentDir, 'sessions', 'b', 'renamed.jsonl'), cwd: '/work/b' }, incomplete: false });
  });

  const sortedStores = (agentDir) => async (path, options) => {
    const entries = await readdir(path, options);
    return path === join(agentDir, 'sessions') ? entries.sort((x, y) => x.name.localeCompare(y.name)) : entries;
  };
  const validated = async (match) => { await validatePiSessionJsonlFile(match.path); return match; };

  it('goes on past a same-id file it cannot accept and finds a later valid one', async () => {
    const { agentDir, storeA } = await store();
    await writeFile(join(storeA, 'broken.jsonl'), `${JSON.stringify({ type: 'session', id: 'caller', cwd: '/work/a' })}\nnot json\n`);
    await expect(scanPiSessionJsonlHeaders({ sessionId: 'caller', agentDir, accept: validated, readDirectory: sortedStores(agentDir) }))
      .resolves.toEqual({ match: { path: join(agentDir, 'sessions', 'b', 'renamed.jsonl'), cwd: '/work/b' }, incomplete: true });
  });

  it('reports a same-id file it cannot accept as incomplete when no other one is valid', async () => {
    const { agentDir, storeA } = await store();
    await writeFile(join(storeA, 'broken.jsonl'), `${JSON.stringify({ type: 'session', id: 'caller', cwd: '/work/a' })}\nnot json\n`);
    await appendFile(join(agentDir, 'sessions', 'b', 'renamed.jsonl'), 'not json\n');
    await expect(scanPiSessionJsonlHeaders({ sessionId: 'caller', agentDir, accept: validated, readDirectory: sortedStores(agentDir) }))
      .resolves.toEqual({ match: null, incomplete: true });
  });

  it.skipIf(!existsSync('/proc/self/fd'))('closes every file it read, also after an early header match', async () => {
    const { agentDir, storeA } = await store();
    // Larger than the read stream buffer, so a file is never read to its end.
    const body = `${JSON.stringify({ type: 'message', text: 'x'.repeat(1024) })}\n`.repeat(256);
    await writeFile(join(storeA, 'large.jsonl'), `${JSON.stringify({ type: 'session', id: 'other', cwd: '/work/a' })}\n${body}`);
    await appendFile(join(agentDir, 'sessions', 'b', 'renamed.jsonl'), body);
    const openFiles = () => readdirSync('/proc/self/fd').length;
    const before = openFiles();
    for (let scan = 0; scan < 20; scan += 1) {
      await expect(scanPiSessionJsonlHeaders({ sessionId: 'caller', agentDir })).resolves.toMatchObject({ match: { cwd: '/work/b' } });
    }
    await vi.waitFor(() => expect(openFiles()).toBeLessThan(before + 5));
  });

  it('reports a store it could not read as incomplete, not as absence', async () => {
    const { agentDir, storeA } = await store();
    const readDirectory = async (path, options) => {
      if (path === storeA) throw Object.assign(new Error('io'), { code: 'EIO' });
      return readdir(path, options);
    };
    await expect(scanPiSessionJsonlHeaders({ sessionId: 'other', agentDir, readDirectory }))
      .resolves.toEqual({ match: null, incomplete: true });
  });

  it('treats a missing sessions root as absence', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'pichamber-pi-header-scan-empty-'));
    await expect(scanPiSessionJsonlHeaders({ sessionId: 'caller', agentDir }))
      .resolves.toEqual({ match: null, incomplete: false });
  });
});

describe('Pi session JSONL validation', () => {
  it('encodes Windows drive-letter cwds the same way Pi SessionManager does', () => {
    expect(encodePiSessionCwd('C:\\Users\\name\\project')).toBe('--C--Users-name-project--');
    expect(encodePiSessionCwd('/home/ryder/project')).toBe('--home-ryder-project--');
  });

  it('normalizes Git Bash drive paths before encoding on Windows', () => {
    expect(normalizeWindowsShellPath('/c/Users/name/project')).toBe('C:\\Users\\name\\project');
    expect(normalizeWindowsShellPath('/cygdrive/d/code')).toBe('D:\\code');
    expect(normalizeWindowsShellPath('/mnt/e/repo')).toBe('E:\\repo');
    const directory = getPiSessionDirectory({
      cwd: '/c/Users/name/project',
      agentDir: 'C:\\Users\\name\\.pi\\agent',
      platform: 'win32',
      resolvePath: (value) => value,
    });
    expect(directory.replace(/\\/g, '/')).toMatch(/sessions\/--C--Users-name-project--$/);
  });

  it('accepts valid Pi session JSONL files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-jsonl-'));
    const cwd = join(root, 'project');
    const agentDir = join(root, 'agent');
    const sessionDirectory = getPiSessionDirectory({ cwd, agentDir });
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(join(sessionDirectory, 'valid.jsonl'), `${validHeader(cwd)}\n`);

    await expect(validatePiSessionJsonlDirectory({ cwd, agentDir })).resolves.toBeUndefined();
  });

  it('reports malformed JSONL rather than silently omitting the session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-jsonl-'));
    const cwd = join(root, 'project');
    const agentDir = join(root, 'agent');
    const sessionDirectory = getPiSessionDirectory({ cwd, agentDir });
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(join(sessionDirectory, 'corrupt.jsonl'), `${validHeader(cwd)}\nnot-json\n`);

    await expect(validatePiSessionJsonlFile(join(sessionDirectory, 'corrupt.jsonl'))).rejects.toMatchObject({
      code: 'MALFORMED_SESSION_JSONL',
    });
    // Directory list/startup only require a valid header so a later corrupt
    // line cannot make every sessions.list read 16MB transcripts.
    await expect(validatePiSessionJsonlDirectory({ cwd, agentDir })).resolves.toBeUndefined();
    await expect(listPiSessionJsonlDirectory({ cwd, agentDir })).resolves.toEqual([
      expect.objectContaining({ id: 'session-one', cwd }),
    ]);
  });

  it('reports unreadable session files explicitly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-jsonl-'));

    await expect(validatePiSessionJsonlFile(join(root, 'missing.jsonl'))).rejects.toMatchObject({
      code: 'SESSION_JSONL_UNREADABLE',
    });
  });

  it('matches Pi SessionManager filenames without treating session-1 as session-10', () => {
    expect(matchesPiSessionJsonlName('2026-01-01T00-00-00-000Z_session-one.jsonl', 'session-one')).toBe(true);
    expect(matchesPiSessionJsonlName('session-one.jsonl', 'session-one')).toBe(true);
    expect(matchesPiSessionJsonlName('2026-01-01T00-00-00-000Z_session-10.jsonl', 'session-1')).toBe(false);
    expect(matchesPiSessionJsonlName('other.jsonl', 'session-one')).toBe(false);
  });

  it('finds a session by filename without reading unrelated transcripts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-jsonl-'));
    const cwd = join(root, 'project');
    const agentDir = join(root, 'agent');
    const sessionDirectory = getPiSessionDirectory({ cwd, agentDir });
    await mkdir(sessionDirectory, { recursive: true });
    const targetId = '01a019b7-ce87-7be9-8fdd-4ed2ce979f5f';
    await writeFile(
      join(sessionDirectory, `2026-08-19T11-13-31-038Z_${targetId}.jsonl`),
      `${JSON.stringify({ type: 'session', version: 3, id: targetId, timestamp: '2026-08-19T11:13:31.038Z', cwd })}\n`,
    );
    await writeFile(join(sessionDirectory, 'unrelated.jsonl'), `${validHeader(cwd)}\n`);

    await expect(findPiSessionJsonlById({ sessionId: targetId, agentDir })).resolves.toMatchObject({
      id: targetId,
      cwd,
    });
    await expect(findPiSessionJsonlById({ sessionId: '01a019b7-ce87-7be9-8fdd-missing', agentDir })).resolves.toBeNull();
  });

  it('lists session metadata without reading a padded transcript body', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-jsonl-'));
    const cwd = join(root, 'project');
    const agentDir = join(root, 'agent');
    const sessionDirectory = getPiSessionDirectory({ cwd, agentDir });
    await mkdir(sessionDirectory, { recursive: true });
    const padding = `${JSON.stringify({ type: 'message', message: { role: 'assistant', content: 'x'.repeat(1024) } })}\n`.repeat(800);
    await writeFile(
      join(sessionDirectory, '2026-01-01T00-00-00-000Z_session-one.jsonl'),
      [
        validHeader(cwd),
        JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'First prompt about listing' }] } }),
        padding.trimEnd(),
        JSON.stringify({ type: 'session_info', name: 'Renamed from tail' }),
        '',
      ].join('\n'),
    );

    const started = Date.now();
    const listed = await listPiSessionJsonlDirectory({ cwd, agentDir });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(listed).toEqual([
      expect.objectContaining({
        id: 'session-one',
        cwd,
        name: 'Renamed from tail',
        firstMessage: 'First prompt about listing',
      }),
    ]);
    expect(listed[0].path).toContain('session-one.jsonl');
  });

  const writeLargeSession = async ({ name = '2026-01-01T00-00-00-000Z_session-one.jsonl', lines }) => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-jsonl-'));
    const cwd = join(root, 'project');
    const agentDir = join(root, 'agent');
    const sessionDirectory = getPiSessionDirectory({ cwd, agentDir });
    await mkdir(sessionDirectory, { recursive: true });
    const file = join(sessionDirectory, name);
    await writeFile(file, `${lines(cwd).join('\n')}\n`);
    return { cwd, agentDir, file };
  };
  const padding = (kib) => Array.from(
    { length: kib },
    () => JSON.stringify({ type: 'message', message: { role: 'assistant', content: 'x'.repeat(1000) } }),
  );
  const userPrompt = (text) => JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text }] } });
  const rename = (name) => JSON.stringify({ type: 'session_info', name });

  it('lists the latest rename of a forked session even when it lies far before the end of the file', async () => {
    // A fork copies the parent path, including its original title, so the
    // head carries the parent's name and the rename lies deep in the file.
    const { cwd, agentDir } = await writeLargeSession({
      lines: (sessionCwd) => [
        JSON.stringify({ type: 'session', version: 3, id: 'session-one', timestamp: '2026-01-01T00:00:00.000Z', cwd: sessionCwd, parentSession: '/parent.jsonl' }),
        rename('Parent title'),
        userPrompt('First prompt of the parent'),
        ...padding(600),
        rename('Fork name'),
        ...padding(300),
      ],
    });

    const listed = await listPiSessionJsonlDirectory({ cwd, agentDir });
    expect(listed).toEqual([expect.objectContaining({ id: 'session-one', name: 'Fork name', firstMessage: 'First prompt of the parent' })]);
  });

  it('keeps an explicitly cleared name cleared in a large session', async () => {
    const { cwd, agentDir } = await writeLargeSession({
      lines: (sessionCwd) => [validHeader(sessionCwd), rename('First title'), userPrompt('Prompt'), ...padding(600), rename(''), ...padding(300)],
    });

    const [listed] = await listPiSessionJsonlDirectory({ cwd, agentDir });
    expect(listed.name).toBeUndefined();
  });

  it('keeps the name from the head of a large session that was not renamed later', async () => {
    const { cwd, agentDir } = await writeLargeSession({
      lines: (sessionCwd) => [validHeader(sessionCwd), rename('Head title'), userPrompt('Prompt'), ...padding(900)],
    });

    const [listed] = await listPiSessionJsonlDirectory({ cwd, agentDir });
    expect(listed.name).toBe('Head title');
  });

  it('reads only what was appended since the previous cached listing', async () => {
    const { cwd, agentDir, file } = await writeLargeSession({
      lines: (sessionCwd) => [validHeader(sessionCwd), rename('First title'), userPrompt('Prompt'), ...padding(700)],
    });
    const cache = createPiSessionListCache();

    await expect(listPiSessionJsonlDirectory({ cwd, agentDir, cache })).resolves.toEqual([expect.objectContaining({ name: 'First title' })]);

    await appendFile(file, `${[rename('Renamed later'), ...padding(300)].join('\n')}\n`);
    await expect(listPiSessionJsonlDirectory({ cwd, agentDir, cache })).resolves.toEqual([expect.objectContaining({ name: 'Renamed later' })]);

    // An unchanged file is served from the cache without opening it again.
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      await chmod(file, 0o000);
      try {
        await expect(listPiSessionJsonlDirectory({ cwd, agentDir, cache })).resolves.toEqual([expect.objectContaining({ name: 'Renamed later' })]);
        await expect(listPiSessionJsonlDirectory({ cwd, agentDir })).rejects.toMatchObject({ code: 'SESSION_JSONL_UNREADABLE' });
      } finally {
        await chmod(file, 0o600);
      }
    }
  });

  it('picks up a cached rename once its line has finished writing', async () => {
    const { cwd, agentDir, file } = await writeLargeSession({
      lines: (sessionCwd) => [validHeader(sessionCwd), rename('First title'), userPrompt('Prompt'), ...padding(700)],
    });
    const cache = createPiSessionListCache();
    const pendingLine = rename('Finished');
    const splitAt = pendingLine.indexOf('Fin');

    await appendFile(file, pendingLine.slice(0, splitAt));
    await expect(listPiSessionJsonlDirectory({ cwd, agentDir, cache })).resolves.toEqual([expect.objectContaining({ name: 'First title' })]);

    await appendFile(file, `${pendingLine.slice(splitAt)}\n`);
    await expect(listPiSessionJsonlDirectory({ cwd, agentDir, cache })).resolves.toEqual([expect.objectContaining({ name: 'Finished' })]);
  });

  it('rereads a cached session file that was rewritten instead of appended to', async () => {
    const { cwd, agentDir, file } = await writeLargeSession({
      lines: (sessionCwd) => [validHeader(sessionCwd), rename('Old'), userPrompt('Prompt'), ...padding(700)],
    });
    const cache = createPiSessionListCache();
    await expect(listPiSessionJsonlDirectory({ cwd, agentDir, cache })).resolves.toEqual([expect.objectContaining({ id: 'session-one', name: 'Old' })]);

    await writeFile(file, `${[
      JSON.stringify({ type: 'session', version: 3, id: 'session-two', timestamp: '2026-01-02T00:00:00.000Z', cwd }),
      rename('New'),
      userPrompt('Other prompt'),
      ...padding(800),
    ].join('\n')}\n`);
    await expect(listPiSessionJsonlDirectory({ cwd, agentDir, cache })).resolves.toEqual([
      expect.objectContaining({ id: 'session-two', name: 'New', firstMessage: 'Other prompt' }),
    ]);
  });

  it('lists every session file in a crowded directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-jsonl-'));
    const cwd = join(root, 'project');
    const agentDir = join(root, 'agent');
    const sessionDirectory = getPiSessionDirectory({ cwd, agentDir });
    await mkdir(sessionDirectory, { recursive: true });
    const ids = Array.from({ length: 24 }, (_, index) => `session-${String(index).padStart(2, '0')}`);
    await Promise.all(ids.map((id) => writeFile(
      join(sessionDirectory, `${id}.jsonl`),
      `${JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-01-01T00:00:00.000Z', cwd })}\n${JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: `Prompt ${id}` }] } })}\n`,
    )));

    const listed = await listPiSessionJsonlDirectory({ cwd, agentDir });
    expect(listed.map((session) => session.id).sort()).toEqual([...ids].sort());
    expect(listed.every((session) => session.cwd === cwd && session.firstMessage?.startsWith('Prompt '))).toBe(true);
  });

  it('fails the directory list when one session header is malformed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-jsonl-'));
    const cwd = join(root, 'project');
    const agentDir = join(root, 'agent');
    const sessionDirectory = getPiSessionDirectory({ cwd, agentDir });
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(join(sessionDirectory, 'valid.jsonl'), `${validHeader(cwd)}\n`);
    await writeFile(join(sessionDirectory, 'broken.jsonl'), '{"type":"not-a-session"}\n');

    await expect(listPiSessionJsonlDirectory({ cwd, agentDir })).rejects.toMatchObject({
      code: 'MALFORMED_SESSION_JSONL',
    });
  });
});
