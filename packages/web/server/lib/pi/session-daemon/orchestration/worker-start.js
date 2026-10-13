import { realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { addWorktree, createBranchAt, fetch, getWorktrees, resolveCommit, resolveWorktreeTopLevel } from '../../../git/index.js';
import { OrchestrationError } from './errors.js';

// The git half of `worker_start`: the branch from `origin/dev` and its
// worktree. Each step checks what already exists first, so the same call after
// a failure continues where it stopped. Nothing is rolled back.

const BASE = { remote: 'origin', branch: 'dev' };
const BASE_REF = 'refs/remotes/origin/dev';
const gitService = { addWorktree, createBranchAt, fetch, getWorktrees, resolveCommit, resolveWorktreeTopLevel };

const canonical = (directory) => realpath(directory).catch(() => resolve(directory));

const atStep = async (step, run) => {
  try {
    return await run();
  } catch (error) {
    throw new OrchestrationError('WORKER_START_FAILED', `Worker start failed at step ${step}: ${error?.message ?? String(error)}`, { step });
  }
};

/**
 * Branch `branchName` from `origin/dev` in the repository of `cwd` and its
 * worktree at `<worktreeRoot>/<branchName>` (default root: the parent of the
 * worktree of `cwd`). An existing branch is reused only when it still points
 * at `origin/dev` or is checked out at that path; an existing worktree only
 * when it is that path on that branch.
 */
export const prepareWorkerTree = async ({ cwd, branchName, worktreeRoot, git = gitService }) => {
  const root = worktreeRoot ?? dirname((await git.resolveWorktreeTopLevel(cwd)).root);
  const worktree = join(root, branchName);
  const target = await canonical(worktree);
  const existing = await atStep('branch', async () => {
    await git.fetch(cwd, BASE);
    const base = await git.resolveCommit(cwd, BASE_REF);
    if (!base) throw new Error('origin/dev does not exist after the fetch.');
    const worktrees = await Promise.all((await git.getWorktrees(cwd))
      .map(async (entry) => ({ ...entry, canonical: await canonical(entry.path) })));
    const atPath = worktrees.find((entry) => entry.canonical === target);
    if (atPath) {
      if (atPath.branch !== branchName) throw new Error(`${worktree} is a worktree on ${atPath.branch ?? 'a detached HEAD'}, not ${branchName}.`);
      return atPath;
    }
    const tip = await git.resolveCommit(cwd, `refs/heads/${branchName}`);
    if (!tip) {
      await git.createBranchAt(cwd, branchName, BASE_REF);
      return undefined;
    }
    const elsewhere = worktrees.find((entry) => entry.branch === branchName);
    if (elsewhere) throw new Error(`Branch ${branchName} is checked out in ${elsewhere.path}; choose another branchName.`);
    if (tip !== base) throw new Error(`Branch ${branchName} exists and does not point at origin/dev; choose another branchName.`);
    return undefined;
  });
  if (!existing) await atStep('worktree', () => git.addWorktree(cwd, worktree, branchName));
  return { branch: branchName, worktree: existing?.path ?? worktree };
};
