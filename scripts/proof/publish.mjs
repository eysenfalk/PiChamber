import { execFileSync } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { validName } from './tours.mjs';
import { markdownEscape } from './media.mjs';
import { diagnosticText } from './diagnostics.mjs';
import { validateCheckout } from './checkout.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const usage = 'bun run proof:publish -- <pr> <tour> [--remote NAME|URL|PATH] [--repo OWNER/NAME] [--dry-run]';
export const resolveRemoteUrl = (remote, cwd) => remote.includes(':') ? remote : resolve(cwd, remote);
const git = (cwd, args) => {
  try {
    return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000,
      env: { ...process.env, GIT_AUTHOR_NAME: 'PiChamber proof recorder', GIT_AUTHOR_EMAIL: 'proof@pichamber.invalid',
        GIT_COMMITTER_NAME: 'PiChamber proof recorder', GIT_COMMITTER_EMAIL: 'proof@pichamber.invalid' },
    }).trim();
  } catch (error) { throw new Error(diagnosticText('git ' + args[0] + ' failed: ' + (error.stderr?.toString() || 'command unsuccessful'))); }
};
export function validatePublish({ pr, tour, repo, remote }) {
  if (!/^[1-9][0-9]*$/.test(String(pr)) || !Number.isSafeInteger(Number(pr))) throw new Error('PR must be a positive integer');
  if (!validName(tour)) throw new Error('Invalid tour name');
  if (typeof repo !== 'string' || (repo.split('/').length !== 2 || repo.split('/').some(part => !/^[a-zA-Z0-9_.-]+$/.test(part))) || repo.split('/').some(part => part === '.' || part === '..')) throw new Error('Repository must be owner/name');
  if (typeof remote !== 'string' || !remote || remote.startsWith('-') || /[\r\n]/.test(remote)) throw new Error('Invalid remote');
}

export function publishMarkdown({ pr, tour, repo, steps, commit, dryRun = false }) {
  if (!dryRun && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new Error('Published links require a commit SHA');
  const base = 'https://raw.githubusercontent.com/' + repo + '/' + (dryRun ? 'proofs' : commit) + '/pr-' + pr + '/' + tour + '/';
  return (dryRun ? '**Dry run: not published.**\n\n' : '') + '[Video](' + base + 'video.mp4)\n\n' +
    '![Contact sheet](' + base + 'contact-sheet.png)\n\n' + steps.map(step =>
      '![' + markdownEscape(diagnosticText(step.caption, 500)) + '](' + base + step.image + ')').join('\n\n') + '\n';
}

async function proofFiles(source, tour) {
  const report = JSON.parse(await readFile(join(source, 'report.json'), 'utf8'));
  if (report.status !== 'proven' || report.tour !== tour || !Array.isArray(report.steps) || !report.steps.length) throw new Error('Only a complete proven recording can be published');
  if (report.steps.some((step, index) => typeof step.caption !== 'string' || !step.caption.trim() || step.image !== String(index + 1).padStart(2, '0') + '.png')) throw new Error('Invalid proof step report');
  const files = ['video.mp4', 'contact-sheet.png', 'index.md', 'report.json', ...report.steps.map(step => step.image)];
  const entries = await readdir(source);
  if (entries.some(name => !files.includes(name))) throw new Error('Unexpected proof files (failed or incomplete run)');
  for (const file of files) {
    const stat = await lstat(join(source, file));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) throw new Error('Missing, empty or unsafe artifact: ' + file);
  }
  return { report, files };
}

/** Isolated staging repository + linked worktree. Never changes the caller's index, refs or checkout. */
export async function publishProof(options) {
  try { return await prepareProof(options); }
  catch (error) { throw new Error(diagnosticText(error.message)); }
}

async function prepareProof({ pr, tour, cwd = root, remote = 'origin', repo, dryRun = false, proofRoot = join(cwd, '.proof') }) {
  repo ??= JSON.parse(await readFile(join(cwd, 'workflow.json'), 'utf8')).tracker.repo;
  validatePublish({ pr, tour, repo, remote });
  const source = join(proofRoot, tour);
  if ((await lstat(source)).isSymbolicLink()) throw new Error('Proof directory must not be a symbolic link');
  const { report, files } = await proofFiles(source, tour);
  validateCheckout(report.checkout);
  if (report.checkout.commit !== git(cwd, ['rev-parse', 'HEAD'])) throw new Error('Proof checkout differs from HEAD; record again before publishing');
  // A configured remote name is resolved from the host; URLs and local paths are accepted too.
  let remoteUrl = remote;
  const remotes = git(cwd, ['remote']).split('\n');
  if (remotes.includes(remote)) remoteUrl = git(cwd, ['remote', 'get-url', remote]);
  remoteUrl = resolveRemoteUrl(remoteUrl, cwd);
  const temp = await mkdtemp(join(tmpdir(), 'pichamber-proof-publish-'));
  const staging = join(temp, 'repo'), tree = join(temp, 'worktree');
  let worktreeAdded = false;
  try {
    await mkdir(staging);
    git(staging, ['init', '--quiet']);
    const branch = git(staging, ['ls-remote', '--heads', '--', remoteUrl, 'refs/heads/proofs']);
    if (branch) {
      git(staging, ['fetch', '--quiet', '--', remoteUrl, 'refs/heads/proofs:refs/heads/proofs']);
      git(staging, ['worktree', 'add', '--quiet', tree, 'proofs']);
      worktreeAdded = true;
    } else {
      // Empty bootstrap commit is not an ancestor of proofs. --orphan creates its own root.
      git(staging, ['commit', '--quiet', '--allow-empty', '-m', 'Initialize temporary proof staging']);
      git(staging, ['worktree', 'add', '--quiet', '--detach', tree, 'HEAD']);
      worktreeAdded = true;
      git(tree, ['checkout', '--quiet', '--orphan', 'proofs']);
    }
    const parent = join(tree, 'pr-' + pr);
    try {
      const stat = await lstat(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe proof destination');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const destination = join(parent, tour);
    await rm(destination, { recursive: true, force: true });
    await mkdir(destination, { recursive: true });
    for (const file of files) await copyFile(join(source, file), join(destination, file));
    git(tree, ['add', '--', 'pr-' + pr + '/' + tour]);
    const changed = git(tree, ['diff', '--cached', '--name-only']);
    if (changed) git(tree, ['commit', '--quiet', '-m', 'Proof for PR #' + pr + ': ' + tour]);
    const commit = git(tree, ['rev-parse', 'HEAD']);
    if (!dryRun) git(tree, ['push', '--quiet', '--', remoteUrl, 'HEAD:refs/heads/proofs']);
    return { commit, dryRun, markdown: publishMarkdown({ pr, tour, repo, steps: report.steps, commit, dryRun }) };
  } finally {
    try { if (worktreeAdded) git(staging, ['worktree', 'remove', '--force', tree]); }
    finally { await rm(temp, { recursive: true, force: true }); }
  }
}

async function main() {
  const args = process.argv.slice(2).filter((arg, index) => !(index === 0 && arg === '--'));
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    remote: { type: 'string' }, repo: { type: 'string' }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) { console.log(usage); return; }
  if (positionals.length !== 2) throw new Error('PR and tour required; see --help');
  const result = await publishProof({ pr: positionals[0], tour: positionals[1], cwd: root,
    remote: values.remote || process.env.PROOF_REMOTE || 'origin', repo: values.repo || process.env.PROOF_REPO, dryRun: values['dry-run'] || false });
  process.stdout.write(result.markdown);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.code?.startsWith('ERR_PARSE_ARGS') ? 'Usage: ' + usage + ' (' + diagnosticText(error.message).replace(/\s+/g, ' ') + ')' : diagnosticText(error.message)); process.exitCode = 1; });
