import { expect, test } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// PiChamber's parent may point PI_PACKAGE_DIR into an Electron asar.
const packageDir = process.env.PI_PACKAGE_DIR;
delete process.env.PI_PACKAGE_DIR;
const { seedLab, SessionManager, SEED_MANIFEST } = await import('./seed.mjs');
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
