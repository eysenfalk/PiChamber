import { expect, test } from 'bun:test';
import { mkdtemp, rm, stat, mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { existsSync } from 'node:fs';
// PiChamber's parent may point PI_PACKAGE_DIR into an Electron asar.
const packageDir = process.env.PI_PACKAGE_DIR;
delete process.env.PI_PACKAGE_DIR;
const { seedLab, SessionManager, SEED_MANIFEST, FORK_WORK_AFTER_RENAME_BYTES, remotePath } = await import('./seed.mjs');
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
      const expected = seed.sessions.filter((s) => s.directory === project.path);
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
    // Orchestration (#107): the orchestrator runs on the faux model the seeded extension registers.
    const orchestrator = seed.sessions.find((s) => s.role === 'orchestrator');
    const orchestratorModel = SessionManager.open(orchestrator.path).getEntries().find((e) => e.type === 'model_change');
    expect([orchestratorModel.provider, orchestratorModel.modelId]).toEqual(['faux', 'faux-1']);
    const extension = await readFile(join(root, 'pi-agent/extensions/faux-orchestration.js'), 'utf8');
    expect(extension).toContain('pi.registerProvider(faux.provider)');
    expect(extension).toContain(JSON.stringify(orchestrator.directory));
    // The pod's memory is below the host gate's minimum, so the seed switches the gate off for the lab server,
    // and it marks the orchestrator, since only a marked session orchestrates (#136).
    expect(JSON.parse(await readFile(join(root, 'pichamber/pi/settings.json'), 'utf8'))).toEqual({
      version: 1, orchestration: { gate: { enabled: false }, orchestrators: { [orchestrator.id]: true } },
    });
    // Sidebar tree fixtures: committed projects, linked worktrees, a fork chain, a home chat and a foreign folder.
    const alpha = seed.projects.find((p) => p.name === 'lab-alpha');
    const worktrees = spawnSync('git', ['-C', alpha.path, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' }).stdout;
    for (const worktree of SEED_MANIFEST.worktrees) {
      const path = join(root, 'projects', 'lab-alpha-worktrees', worktree.name);
      expect(worktrees).toContain(`worktree ${path}\nHEAD `);
      // A stopped rebase detaches HEAD; every other worktree has its branch checked out.
      if (worktree.git !== 'rebase') expect(worktrees).toContain(`branch refs/heads/${worktree.name}`);
      const branchLine = spawnSync('git', ['-C', path, 'status', '--short', '--branch'], { encoding: 'utf8' }).stdout.split('\n')[0];
      if (worktree.git === 'dirty') expect(branchLine).toBe(`## ${worktree.name}...main [behind 1]`);
      if (worktree.git === 'ahead-behind') expect(branchLine).toBe(`## ${worktree.name}...main [ahead 2, behind 1]`);
      if (worktree.git === 'remote-ahead') {
        // Tracks the bare remote and shows neither ahead nor behind: the remote's extra commit is not fetched yet.
        expect(branchLine).toBe(`## ${worktree.name}...origin/${worktree.name}`);
        const remote = remotePath(root, worktree.project);
        const remoteHead = spawnSync('git', ['-C', remote, 'rev-parse', `refs/heads/${worktree.name}`], { encoding: 'utf8' }).stdout.trim();
        const trackingHead = spawnSync('git', ['-C', path, 'rev-parse', `refs/remotes/origin/${worktree.name}`], { encoding: 'utf8' }).stdout.trim();
        expect(remoteHead).not.toBe(trackingHead);
        expect(spawnSync('git', ['-C', remote, 'rev-list', '--count', `${trackingHead}..${remoteHead}`], { encoding: 'utf8' }).stdout.trim()).toBe('1');
        // The fetch Auto fetch runs makes the remote commit visible as one behind.
        expect(spawnSync('git', ['-C', alpha.path, 'fetch', '--quiet', 'origin'], { encoding: 'utf8' }).status).toBe(0);
        expect(spawnSync('git', ['-C', path, 'status', '--short', '--branch'], { encoding: 'utf8' }).stdout.split('\n')[0])
          .toBe(`## ${worktree.name}...origin/${worktree.name} [behind 1]`);
      }
      const session = seed.sessions.find((s) => s.worktree === worktree.name);
      if (!session) continue;
      expect(session.directory).toBe(path);
      expect((await SessionManager.list(path, SessionManager.open(session.path).getSessionDir())).map((s) => s.name)).toEqual([session.title]);
    }
    const dirty = SEED_MANIFEST.worktrees.find((worktree) => worktree.git === 'dirty');
    expect(spawnSync('git', ['-C', join(root, 'projects', 'lab-alpha-worktrees', dirty.name), 'status', '--porcelain'], { encoding: 'utf8' }).stdout.trim().split('\n')).toHaveLength(2);
    const rebase = SEED_MANIFEST.worktrees.find((worktree) => worktree.git === 'rebase');
    const rebaseDir = spawnSync('git', ['-C', join(root, 'projects', 'lab-alpha-worktrees', rebase.name), 'rev-parse', '--git-path', 'rebase-merge'], { encoding: 'utf8' }).stdout.trim();
    expect(existsSync(isAbsolute(rebaseDir) ? rebaseDir : join(root, 'projects', 'lab-alpha-worktrees', rebase.name, rebaseDir))).toBe(true);
    expect(spawnSync('git', ['-C', alpha.path, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).stdout.trim()).toBe('main');
    const forkChild = seed.sessions.find((s) => s.role === 'fork-child');
    expect(SessionManager.open(forkChild.path).getHeader().parentSession).toBe(fork.path);
    expect(SessionManager.open(forkChild.path).getSessionName()).toBe(forkChild.title);
    expect(seed.sessions.find((s) => s.role === 'chat').directory).toBe(root);
    expect(seed.sessions.find((s) => s.role === 'foreign').directory).toBe(join(root, 'folders', 'scratch'));
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
