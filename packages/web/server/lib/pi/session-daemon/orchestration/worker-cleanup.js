import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

import { OrchestrationError } from './errors.js';

// The git half of `worker_cleanup` (#118). Each step checks what is still
// there first, so the same call after a failure continues where it stopped.
// The guard (`cleanup-guard.js`) decides before any step runs.

// Nobody can answer a prompt from the daemon.
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', SSH_ASKPASS: '' };

const git = (args, cwd) => new Promise((done, fail) => {
  execFile('git', args, { cwd, env: GIT_ENV, timeout: 60_000 }, (error, stdout, stderr) => {
    if (error) fail(new Error(String(stderr || error.message).trim()));
    else done(String(stdout).trim());
  });
});

const canonical = (path) => realpath(path).catch(() => resolve(path));

/**
 * Worktree, repository git dir and branch of a worker directory. Only a
 * linked worktree qualifies: the main checkout is never removed. Throws with
 * the reason otherwise.
 */
export const resolveCleanupTarget = async (cwd) => {
  let paths;
  try {
    paths = (await git(['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir'], cwd)).split('\n');
  } catch (error) {
    throw new Error(`The worker directory is no git worktree: ${error.message}`);
  }
  const [worktree, gitDir, commonDir] = paths;
  if (await canonical(gitDir) === await canonical(commonDir)) {
    throw new Error(`${worktree} is the main checkout of its repository, not a worker worktree.`);
  }
  const branch = await git(['branch', '--show-current'], worktree);
  // The merge proof is read from github.com; another origin has none.
  // The configured URL, not one rewritten by `insteadOf`.
  const origin = await git(['config', '--get', 'remote.origin.url'], worktree).catch(() => '');
  const repository = origin.match(/github\.com[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/)?.[1];
  return { worktree, gitDir: commonDir, ...(branch ? { branch } : {}), ...(repository ? { repository } : {}) };
};

const inRepo = (target, args) => ['--git-dir', target.gitDir, ...args];

/**
 * What is left of a target: the local tip, whether the worktree is
 * registered, and if so whether it is clean and which branch and HEAD it holds.
 */
export const readTreeState = async (target) => {
  const localTip = await git(inRepo(target, ['for-each-ref', '--format=%(objectname)', `refs/heads/${target.branch}`])) || undefined;
  const listed = (await git(inRepo(target, ['worktree', 'list', '--porcelain'])))
    .split('\n').filter((line) => line.startsWith('worktree ')).map((line) => line.slice('worktree '.length));
  const wanted = await canonical(target.worktree);
  const present = (await Promise.all(listed.map(canonical))).includes(wanted);
  if (!present) return { localTip, present, clean: true };
  const clean = (await git(['status', '--porcelain'], target.worktree)) === '';
  const checkedOut = await git(['branch', '--show-current'], target.worktree);
  const head = await git(['rev-parse', 'HEAD'], target.worktree);
  return { localTip, present, clean, checkedOut, head };
};

/**
 * Removes the worktree (never forced), the local branch (`-D`: after a squash
 * `-d` refuses, the guard proved the tip) and the remote branch under a lease
 * on the merged head. Returns what it removed.
 */
export const removeWorkerTree = async (target, tree, headSha) => {
  const removed = [];
  const step = async (name, run) => {
    try {
      await run();
    } catch (error) {
      throw new OrchestrationError('WORKER_CLEANUP_FAILED', `Cleanup failed at step ${name}: ${error?.message ?? String(error)}. Fix the cause and call worker_cleanup again.`, { step: name, removed });
    }
  };
  await step('worktree', async () => {
    if (!tree.present) return;
    await git(inRepo(target, ['worktree', 'remove', target.worktree]));
    removed.push(`worktree ${target.worktree}`);
  });
  await step('branch', async () => {
    if (!tree.localTip) return;
    await git(inRepo(target, ['branch', '-D', target.branch]));
    removed.push(`branch ${target.branch}`);
  });
  await step('remote', async () => {
    const ref = `refs/heads/${target.branch}`;
    if (!(await git(inRepo(target, ['ls-remote', '--heads', 'origin', ref])))) return;
    await git(inRepo(target, ['push', 'origin', '--delete', `--force-with-lease=${ref}:${headSha}`, ref]));
    removed.push(`origin ${target.branch}`);
  });
  return removed;
};
