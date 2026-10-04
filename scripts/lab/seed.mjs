import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile, utimes, rm, readdir, lstat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { SessionManager } from '../../packages/web/node_modules/@earendil-works/pi-coding-agent/dist/index.js';
import { getPiSessionDirectory } from '../../packages/web/server/lib/pi/session-daemon/session-jsonl.js';

import { SEED_MANIFEST } from './seed-spec.mjs';
export { SessionManager, SEED_MANIFEST };

const usage = { input: 80, output: 40, cacheRead: 0, cacheWrite: 0, totalTokens: 120,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (text, timestamp, content = []) => ({ role: 'assistant',
  content: [...(text ? [{ type: 'text', text }] : []), ...content], api: 'openai-completions',
  provider: 'openai', model: 'gpt-4.1', usage, stopReason: content.length ? 'toolUse' : 'stop', timestamp });

/** Bytes written after the rename: more than the 128 KiB tail the session list once searched, in a file above its 512 KiB head scan. */
export const FORK_WORK_AFTER_RENAME_BYTES = 600 * 1024;

// A Pi fork copies the parent's path, including the parent's title, then the
// user renames it and keeps working. The bulk sits in collapsed bash output.
function seedRenamedFork({ sourcePath, cwd, sessionDir, title, createdAt }) {
  const fork = SessionManager.forkFrom(sourcePath, cwd, sessionDir);
  fork.appendSessionInfo(title);
  const log = Array.from({ length: 200 }, (_, line) => `synthetic check ${String(line + 1).padStart(3, '0')}: ok`).join('\n');
  const before = Buffer.byteLength(readFileSync(fork.getSessionFile()));
  for (let turn = 0; Buffer.byteLength(readFileSync(fork.getSessionFile())) - before < FORK_WORK_AFTER_RENAME_BYTES; turn++) {
    const id = `lab-fork-bash-${turn}`;
    const timestamp = createdAt + 2002000 + turn * 10;
    fork.appendMessage({ role: 'user', content: `Run synthetic fork check ${turn + 1}.`, timestamp });
    fork.appendMessage(assistant('', timestamp + 1, [{ type: 'toolCall', id, name: 'bash', arguments: { command: `./check.sh ${turn + 1}` } }]));
    fork.appendMessage({ role: 'toolResult', toolCallId: id, toolName: 'bash', content: [{ type: 'text', text: log }], isError: false, timestamp: timestamp + 2 });
    fork.appendMessage(assistant(`Fork check ${turn + 1} passed.`, timestamp + 3));
  }
  return fork;
}

// Every SDK operation gets an explicit volume-local session directory. Tests never use host Pi state.
export async function seedLab(root, now = Date.now()) {
  if (!root || !resolve(root).endsWith('/lab')) throw new Error('Seed root must be an explicit directory named lab.');
  root = resolve(root);
  const marker = join(root, 'seed.json');
  try { return JSON.parse(await readFile(marker, 'utf8')); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const agentDir = join(root, 'pi-agent');
  // Refuse symlinked parents and mixed agent state before deleting interrupted fixtures.
  for (const directory of [root, join(root, 'projects'), agentDir]) {
    try {
      if (!(await lstat(directory)).isDirectory()) throw new Error(`Seed directory must not be a symlink or file: ${directory}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  let agentEntries = [];
  try { agentEntries = await readdir(agentDir); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (agentEntries.some(name => name !== 'sessions')) throw new Error('Seed agent directory must contain only sessions.');
  // A previous interrupted seed has no marker: discard only manifest-owned project names.
  for (const fixture of SEED_MANIFEST.projects) await rm(join(root, 'projects', fixture.name), { recursive: true, force: true });
  await rm(join(agentDir, 'sessions'), { recursive: true, force: true });
  const projects = [];
  const sessions = [];
  for (const [index, fixture] of SEED_MANIFEST.projects.entries()) {
    const cwd = join(root, 'projects', fixture.name);
    await mkdir(cwd, { recursive: true });
    await writeFile(join(cwd, 'README.md'), `# ${fixture.name}\n\nSynthetic proof lab project. No real user data.\n`);
    const git = spawnSync('git', ['init', '--quiet', cwd], { encoding: 'utf8' });
    if (git.error || git.status !== 0) throw git.error ?? new Error(git.stderr);
    projects.push({ name: fixture.name, path: cwd });
    const sessionDir = getPiSessionDirectory({ cwd, agentDir });
    const spec = SEED_MANIFEST.sessions.find((session) => session.project === fixture.name && ['long', 'short'].includes(session.role));
    const forkSpec = SEED_MANIFEST.sessions.find((session) => session.project === fixture.name && session.role === 'fork');
    const createdAt = now - (index + 1) * 86400000;
    // SessionManager owns entry/header timestamps and has no clock parameter.
    // Seed synchronously under a scoped clock, then restore Date before any await or server starts.
    const RealDate = Date;
    let tick = 0;
    globalThis.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [createdAt + tick++ * 1000])); }
      static now() { return createdAt + tick * 1000; }
    };
    const files = [];
    try {
      const manager = SessionManager.create(cwd, sessionDir);
      manager.appendModelChange('openai', 'gpt-4.1');
      // Named before the first prompt, as PiChamber does for new sessions, so a fork's head carries the parent title.
      manager.appendSessionInfo(spec.title);
      const turns = spec.role === 'long' ? 22 : 2;
      for (let turn = 0; turn < turns; turn++) {
        const timestamp = createdAt + turn * 60000;
        manager.appendMessage({ role: 'user', content: `Review step ${turn + 1} for ${fixture.name}. Explain the change and its checks.`, timestamp });
        manager.appendMessage(assistant(`## Step ${turn + 1}\n\nThis is a prepared conversation for the proof lab. We check the implementation, preserve unrelated behavior, and show the result on synthetic data.\n\nThe next check confirms the project files and the expected result.`, timestamp + 1000));
      }
      if (spec.role === 'long') {
        for (const [name, args, result, isError] of [
          ['read', { path: 'README.md' }, `# ${fixture.name}\n\nSynthetic proof lab project.`, false],
          ['edit', { path: 'README.md', oldText: 'Synthetic proof lab project.', newText: 'Synthetic proof lab project. Checked.' }, 'Successfully replaced text in README.md.', false],
          ['bash', { command: 'git status --short' }, '?? README.md', false],
          ['bash', { command: 'test -f missing.txt' }, 'Command exited with code 1', true],
        ]) {
          const id = `lab-${name}-${sessions.length}-${isError}`;
          manager.appendMessage({ role: 'user', content: `Run the synthetic ${name} check${isError ? ' with an expected failure' : ''}.`, timestamp: createdAt + 1799000 });
          manager.appendMessage(assistant('', createdAt + 1800000, [{ type: 'toolCall', id, name, arguments: args }]));
          manager.appendMessage({ role: 'toolResult', toolCallId: id, toolName: name,
            content: [{ type: 'text', text: result }], isError, timestamp: createdAt + 1801000 });
        }
        manager.appendMessage(assistant('The read, edit and git checks completed. The missing file check failed as expected: this is a fixture for error disclosure, not an unfinished run.', createdAt + 1802000));
      }
      const file = manager.getSessionFile();
      files.push({ path: file, modified: createdAt + 1802000 });
      sessions.push({ ...spec, id: manager.getSessionId(), path: file, directory: cwd });
      if (spec.role === 'long') {
        const child = SessionManager.create(cwd, sessionDir, { parentSession: file });
        child.appendMessage({ role: 'user', content: 'Check the documentation in a subsession.', timestamp: createdAt + 2000000 });
        child.appendMessage(assistant('The README contains only synthetic proof lab data.', createdAt + 2001000));
        child.appendSessionInfo('Lab: documentation subsession');
        files.push({ path: child.getSessionFile(), modified: createdAt + 2001000 });
        sessions.push({ project: fixture.name, title: child.getSessionName(), role: 'child',
          id: child.getSessionId(), path: child.getSessionFile(), directory: cwd, parentId: manager.getSessionId() });
      }
      if (forkSpec) {
        const fork = seedRenamedFork({ sourcePath: file, cwd, sessionDir, title: forkSpec.title, createdAt });
        files.push({ path: fork.getSessionFile(), modified: createdAt + 2003000 });
        sessions.push({ ...forkSpec, id: fork.getSessionId(), path: fork.getSessionFile(), directory: cwd,
          parentId: manager.getSessionId() });
      }
    } finally {
      globalThis.Date = RealDate;
    }
    for (const file of files) await utimes(file.path, new Date(createdAt), new Date(file.modified));
  }
  const seed = { projects, sessions };
  await writeFile(marker, JSON.stringify(seed, null, 2) + '\n');
  return seed;
}
