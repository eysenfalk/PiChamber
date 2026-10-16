import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createSessionDaemon } from '../session-daemon.js';
import { connectClient, credential, disableHostGate, markOrchestrator, piAiFauxUrl } from './e2e-support.js';

// The merge guard (#20) through the real daemon, Pi SDK and git. A scripted
// faux model runs shell commands in a clone of a local bare repository: a
// marked orchestrator spawns a worker that pushes to main and to a feature
// branch, then tries itself to push to main and to merge pull requests into
// main and dev through a stand-in `gh` on PATH (the daemon builds its own
// lookup, so the test replaces the program, never reaching GitHub); last an
// unmarked session pushes to main. The bare repository and the stand-in's log
// show what ran.

const fauxExtension = (fauxUrl, clone) => `
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from ${JSON.stringify(fauxUrl)};

const CLONE = ${JSON.stringify(clone)};

const textOf = (message) => typeof message?.content === 'string'
  ? message.content
  : (message?.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\\n');
const bash = (command) => fauxAssistantMessage([fauxToolCall('bash', { command })], { stopReason: 'toolUse' });
const SCRIPTS = {
  'WORKER PUSH': ['git push origin HEAD:main', 'git push origin HEAD:feature'],
  GUARDED: [
    'git push origin HEAD:main',
    'git status --short && git push origin HEAD:feature',
    'git checkout -q main && git push',
    'git checkout -q main && git commit -q --allow-empty -m direct',
    'git push',
    'gh pr merge 7 --squash',
    'gh pr merge 8 --squash',
  ],
  OWNER: ['git push origin HEAD:main'],
};

const respond = async (context) => {
  const log = globalThis.__pichamberMergeGuardLog ??= [];
  const messages = context.messages ?? [];
  const userIndex = messages.findLastIndex((message) => message.role === 'user');
  const task = textOf(messages[userIndex]);
  const results = messages.slice(userIndex + 1).filter((message) => message.role === 'toolResult');
  const last = results.at(-1);
  // A worker's task arrives behind PiChamber's worker preamble.
  const name = Object.keys(SCRIPTS).find((key) => task === key || task.endsWith(key));
  if (last && name) log.push({ task: name, isError: last.isError, text: textOf(last) });
  if (task.startsWith('A worker event')) return fauxAssistantMessage('PARENT WOKEN');
  if (task.includes('ORCHESTRATE')) {
    if (last) return fauxAssistantMessage('PARENT SPAWNED');
    return fauxAssistantMessage([fauxToolCall('mcp__pichamber__session_spawn', {
      cwd: CLONE,
      task: 'WORKER PUSH',
      title: 'Pushing worker',
      model: { providerId: 'faux', modelId: 'faux-1' },
      clientRequestId: 'spawn-pusher',
    })], { stopReason: 'toolUse' });
  }
  const script = SCRIPTS[name];
  if (!script) return fauxAssistantMessage(fauxText('UNSCRIPTED'));
  return results.length < script.length ? bash(script[results.length]) : fauxAssistantMessage(name + ' DONE');
};

export default function (pi) {
  const faux = fauxProvider();
  faux.setResponses(Array.from({ length: 20 }, () => respond));
  pi.registerProvider(faux.provider);
}
`;

// Answers `gh pr view <n>` with the base of PR 7 (main) or 8 (dev) and logs
// every merge it would have run.
const fakeGh = (logFile) => `#!/bin/sh
if [ "$1 $2" = "pr view" ]; then
  case "$3" in 7) echo main ;; 8) echo dev ;; *) echo "no pull request $3" >&2; exit 1 ;; esac
  exit 0
fi
echo "$*" >> ${JSON.stringify(logFile)}
`;

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

describe('merge guard through the real daemon', () => {
  let daemon;
  const previousDataDir = process.env.PICHAMBER_DATA_DIR;
  const previousPath = process.env.PATH;

  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    if (previousDataDir === undefined) delete process.env.PICHAMBER_DATA_DIR;
    else process.env.PICHAMBER_DATA_DIR = previousDataDir;
    process.env.PATH = previousPath;
    delete globalThis.__pichamberMergeGuardLog;
  });

  // The stand-in gh is a POSIX shell script.
  it.skipIf(process.platform === 'win32')('refuses a worker\'s and a marked orchestrator\'s push and merge into main, allows dev and feature branches, and leaves an unmarked session alone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-merge-guard-e2e-'));
    const remote = join(root, 'remote.git');
    const clone = join(root, 'clone');
    const agentDir = join(root, 'agent');
    const binDir = join(root, 'bin');
    const ghLog = join(root, 'gh.log');
    await mkdir(join(agentDir, 'extensions'), { recursive: true });
    await mkdir(binDir);
    await writeFile(join(agentDir, 'extensions', 'faux-merge-guard.ts'), fauxExtension(piAiFauxUrl(), clone));
    await writeFile(join(binDir, 'gh'), fakeGh(ghLog));
    await chmod(join(binDir, 'gh'), 0o755);
    await writeFile(ghLog, '');
    process.env.PATH = `${binDir}${delimiter}${previousPath}`;

    git(root, 'init', '-q', '--bare', '-b', 'main', remote);
    git(root, 'clone', '-q', remote, clone);
    git(clone, 'config', 'user.email', 'guard@example.com');
    git(clone, 'config', 'user.name', 'Guard');
    git(clone, 'commit', '-q', '--allow-empty', '-m', 'initial');
    // Set up as the owner would, outside any session.
    git(clone, 'push', '-q', '-u', 'origin', 'main');
    git(clone, 'checkout', '-q', '-b', 'feature');
    git(clone, 'commit', '-q', '--allow-empty', '-m', 'feature work');
    const mainBefore = git(remote, 'rev-parse', 'main');
    const featureTip = git(clone, 'rev-parse', 'HEAD');

    process.env.PICHAMBER_DATA_DIR = join(root, 'data');
    // Wakes without delay, so the orchestrator's wake turn ends before its next prompt.
    disableHostGate(process.env.PICHAMBER_DATA_DIR, { wakes: { coalesceMs: 0 } });
    const endpoint = join(root, 'daemon.sock');
    daemon = createSessionDaemon({ endpoint, credential, cwd: clone, agentDir });
    await daemon.start();
    const client = connectClient(endpoint);
    await client.authenticate();
    const answer = (text) => client.next((message) => message.event === 'assistant.message.end'
      && message.payload?.text === text, 60_000).catch((error) => {
      throw new Error(`${error.message} (${text}); results: ${JSON.stringify(globalThis.__pichamberMergeGuardLog ?? [])}`);
    });
    const model = { providerId: 'faux', modelId: 'faux-1' };

    const guarded = (await client.request('sessions.create', { cwd: clone, model })).result.session.id;
    markOrchestrator(process.env.PICHAMBER_DATA_DIR, guarded);

    // A worker is guarded: its push to main is refused, its feature push runs.
    const workerDone = answer('WORKER PUSH DONE');
    const parentWoken = answer('PARENT WOKEN');
    await client.request('sessions.prompt', { sessionId: guarded, text: 'ORCHESTRATE a push' });
    expect((await workerDone).payload.sessionId).not.toBe(guarded);
    await parentWoken;
    const [workerMain, workerFeature] = globalThis.__pichamberMergeGuardLog.filter((entry) => entry.task === 'WORKER PUSH');
    expect(workerMain).toMatchObject({ isError: true, text: expect.stringMatching(/^Merge guard: git push HEAD:main updates main\./) });
    expect(workerMain.text).toContain('dev included, stay allowed.');
    expect(workerFeature.isError).toBe(false);
    expect(git(remote, 'rev-parse', 'main')).toBe(mainBefore);
    expect(git(remote, 'rev-parse', 'feature')).toBe(featureTip);

    // The orchestrator itself is guarded as well.
    const guardedDone = answer('GUARDED DONE');
    await client.request('sessions.prompt', { sessionId: guarded, text: 'GUARDED' });
    await guardedDone;

    const results = globalThis.__pichamberMergeGuardLog.filter((entry) => entry.task === 'GUARDED');
    expect(results).toHaveLength(7);
    const [pushMain, pushFeature, switchAndPush, switched, pushCurrent, mergeMain, mergeDev] = results;
    expect(pushMain).toMatchObject({ isError: true, text: expect.stringMatching(/^Merge guard: git push HEAD:main updates main\./) });
    expect(pushFeature.isError).toBe(false);
    // The branch is read before the command runs, so a switch inside it blocks.
    expect(switchAndPush).toMatchObject({ isError: true, text: expect.stringContaining('can change the current branch') });
    expect(switched.isError).toBe(false);
    // The guard read the branch and its upstream from the real repository.
    expect(pushCurrent).toMatchObject({ isError: true, text: expect.stringContaining('git push without a refspec on main tracking main pushes to main.') });
    expect(mergeMain).toMatchObject({ isError: true, text: expect.stringContaining('gh pr merge would merge PR 7 into its base main.') });
    expect(mergeDev.isError).toBe(false);
    expect(git(remote, 'rev-parse', 'main')).toBe(mainBefore);
    expect(await readFile(ghLog, 'utf8')).toBe('pr merge 8 --squash\n');

    // The owner's own session is not guarded.
    const owner = (await client.request('sessions.create', { cwd: clone, model })).result.session.id;
    const ownerDone = answer('OWNER DONE');
    await client.request('sessions.prompt', { sessionId: owner, text: 'OWNER' });
    await ownerDone;
    const ownerPush = globalThis.__pichamberMergeGuardLog.find((entry) => entry.task === 'OWNER');
    expect(ownerPush.isError).toBe(false);
    expect(git(remote, 'rev-parse', 'main')).toBe(git(clone, 'rev-parse', 'HEAD'));
    await client.close();
  }, 180_000);
});
