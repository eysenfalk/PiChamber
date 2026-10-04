import { expect, test } from 'bun:test';
import { mkdtemp, rm, stat, mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// PiChamber's parent may point PI_PACKAGE_DIR into an Electron asar.
const packageDir = process.env.PI_PACKAGE_DIR;
delete process.env.PI_PACKAGE_DIR;
const { seedLab, SessionManager, SEED_MANIFEST, FORK_WORK_AFTER_RENAME_BYTES } = await import('./seed.mjs');
if (packageDir !== undefined) process.env.PI_PACKAGE_DIR = packageDir;

test('SDK-written fixtures round trip, list per project, link a subsession and keep recency order', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'pichamber-seed-'));
  const root = join(temporary, 'lab');
  try {
    const originalDate = Date;
    const seed = await seedLab(root);
    expect(Date).toBe(originalDate);
    expect(seed.projects.map((p) => p.name)).toEqual(SEED_MANIFEST.projects.map((p) => p.name));
    for (const project of seed.projects) {
      expect((await stat(join(project.path, '.git'))).isDirectory()).toBe(true);
      const expected = seed.sessions.filter((s) => s.project === project.name);
      const directory = SessionManager.open(expected[0].path).getSessionDir();
      const listed = await SessionManager.list(project.path, directory);
      expect(listed.map((s) => s.name).sort()).toEqual(expected.map((s) => s.title).sort());
    }
    const long = seed.sessions.find((s) => s.role === 'long');
    const manager = SessionManager.open(long.path);
    const messages = manager.getEntries().filter((e) => e.type === 'message').map((e) => e.message);
    expect(messages.length).toBeGreaterThanOrEqual(40);
    const entries = manager.getEntries();
    const times = [manager.getHeader(), ...entries].map((e) => Date.parse(e.timestamp));
    expect(times.every((time, i) => i === 0 || time > times[i - 1])).toBe(true);
    expect(manager.getHeader().timestamp).not.toBe(SessionManager.open(seed.sessions.find((s) => s.project === 'lab-beta').path).getHeader().timestamp);
    const results = messages.filter((m) => m.role === 'toolResult');
    expect(results.map((m) => m.toolName)).toEqual(['read', 'edit', 'bash', 'bash']);
    expect(results.some((m) => m.isError)).toBe(true);
    const child = seed.sessions.find((s) => s.role === 'child');
    expect(SessionManager.open(child.path).getHeader().parentSession).toBe(long.path);
    const fork = seed.sessions.find((s) => s.role === 'fork');
    const forkText = await readFile(fork.path, 'utf8');
    const forkManager = SessionManager.open(fork.path);
    expect(forkManager.getHeader().parentSession).toBe(long.path);
    expect(forkManager.getSessionName()).toBe(fork.title);
    // The parent's title is copied into the fork; the rename sits far before the end of a large file.
    expect(forkText).toContain(JSON.stringify(long.title));
    const renameAt = Buffer.byteLength(forkText.slice(0, forkText.lastIndexOf('"type":"session_info"')));
    expect(Buffer.byteLength(forkText) - renameAt).toBeGreaterThan(FORK_WORK_AFTER_RENAME_BYTES);
    expect(Buffer.byteLength(forkText)).toBeGreaterThan(512 * 1024);
    expect((await stat(long.path)).mtimeMs).toBeGreaterThan((await stat(seed.sessions.find((s) => s.project === 'lab-beta').path)).mtimeMs);
    expect(await seedLab(root)).toEqual(seed); // A second startup preserves identities and user edits.
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('seeding refuses a missing or ambiguous state root', async () => {
  await expect(seedLab()).rejects.toThrow('explicit directory named lab');
  await expect(seedLab('/tmp')).rejects.toThrow('explicit directory named lab');
});

test('the seed clock restores Date even when the SDK writer throws', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'pichamber-seed-failure-'));
  const originalDate = Date;
  const originalCreate = SessionManager.create;
  try {
    SessionManager.create = () => { throw new Error('Synthetic SDK failure'); };
    await expect(seedLab(join(temporary, 'lab'))).rejects.toThrow('Synthetic SDK failure');
    expect(Date).toBe(originalDate);
  } finally {
    SessionManager.create = originalCreate;
    await rm(temporary, { recursive: true, force: true });
  }
});

test('an interrupted seed preserves projects not named by the manifest', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'pichamber-seed-owned-'));
  const root = join(temporary, 'lab');
  try {
    await mkdir(join(root, 'projects/real-project'), { recursive: true });
    await writeFile(join(root, 'projects/real-project/keep'), 'untouched');
    await seedLab(root);
    expect(await readFile(join(root, 'projects/real-project/keep'), 'utf8')).toBe('untouched');
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

for (const unsafe of ['mixed-agent-state', 'symlinked-projects', 'symlinked-agent']) {
  test(`seeding refuses ${unsafe} before removing any fixture`, async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'pichamber-seed-guard-'));
    const root = join(temporary, 'lab');
    try {
      await mkdir(join(root, 'projects/lab-alpha'), { recursive: true });
      await writeFile(join(root, 'projects/lab-alpha/keep'), 'untouched');
      await mkdir(join(temporary, 'outside/sessions'), { recursive: true });
      await writeFile(join(temporary, 'outside/sessions/keep'), 'untouched');
      if (unsafe === 'mixed-agent-state') {
        await mkdir(join(root, 'pi-agent'));
        await writeFile(join(root, 'pi-agent/auth.json'), 'synthetic');
      } else if (unsafe === 'symlinked-projects') {
        await rm(join(root, 'projects'), { recursive: true });
        await symlink(join(temporary, 'outside'), join(root, 'projects'));
      } else await symlink(join(temporary, 'outside'), join(root, 'pi-agent'));
      await expect(seedLab(root)).rejects.toThrow(unsafe === 'mixed-agent-state' ? 'must contain only sessions' : 'must not be a symlink');
      expect(await readFile(join(temporary, 'outside/sessions/keep'), 'utf8')).toBe('untouched');
      if (unsafe !== 'symlinked-projects') expect(await readFile(join(root, 'projects/lab-alpha/keep'), 'utf8')).toBe('untouched');
    } finally { await rm(temporary, { recursive: true, force: true }); }
  });
}
