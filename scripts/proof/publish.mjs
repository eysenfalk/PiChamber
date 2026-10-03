import { execFileSync } from 'node:child_process';
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { validName } from './tours.mjs';
import { markdownEscape } from './media.mjs';
import { diagnosticText } from './diagnostics.mjs';
import { validateCheckout } from './checkout.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const usage = 'bun run proof:publish -- <pr> <tour> [--repo OWNER/NAME] [--dry-run]';

const git = (cwd, args) => {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 }).trim(); }
  catch (error) { throw new Error(diagnosticText('git ' + args[0] + ' failed: ' + (error.stderr?.toString() || 'command unsuccessful'))); }
};

/** Runs the GitHub CLI. Raw error messages repeat arguments, so only bounded, redacted stderr surfaces. */
export const runGh = (args, { cwd }) => {
  try { return execFileSync('gh', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000 }); }
  catch (error) { throw new Error(diagnosticText('gh ' + args.slice(0, 2).join(' ') + ' failed: ' + (error.stderr?.toString() || 'command unsuccessful'))); }
};

export function validatePublish({ pr, tour, repo }) {
  if (!/^[1-9][0-9]*$/.test(String(pr)) || !Number.isSafeInteger(Number(pr))) throw new Error('PR must be a positive integer');
  if (!validName(tour)) throw new Error('Invalid tour name');
  if (typeof repo !== 'string' || (repo.split('/').length !== 2 || repo.split('/').some(part => !/^[a-zA-Z0-9_.-]+$/.test(part))) || repo.split('/').some(part => part === '.' || part === '..')) throw new Error('Repository must be owner/name');
}

const markers = tour => ['<!-- proof:' + tour + ' -->', '<!-- /proof:' + tour + ' -->'];

/**
 * The proof block with references to the local files, relative to the tour directory. gh --attach uploads each
 * file and rewrites these references in place; the video stands alone in its paragraph so GitHub renders a player.
 */
export function proofBlock({ tour, steps, commit }) {
  const [open, close] = markers(tour);
  return [open, 'Tour `' + tour + '`, recorded at `' + commit.slice(0, 12) + '`.', '![](./video.mp4)', '![Contact sheet](./contact-sheet.png)',
    ...steps.map(step => '![' + markdownEscape(diagnosticText(step.caption, 500)) + '](./' + step.image + ')'), close].join('\n\n');
}

/** Replaces this tour's block, or appends it to the end of the Verification section. Other text stays byte for byte. */
export function withProof(body, tour, block) {
  const [open, close] = markers(tour);
  const start = body.indexOf(open);
  if (start !== -1) {
    const end = body.indexOf(close, start);
    if (end === -1) throw new Error('Description has an unterminated proof block for ' + tour);
    return body.slice(0, start) + block + body.slice(end + close.length);
  }
  const heading = /^## Verification[ \t]*$/m.exec(body);
  if (!heading) throw new Error('Description has no "## Verification" section');
  const next = /^## /m.exec(body.slice(heading.index + heading[0].length));
  const at = next ? heading.index + heading[0].length + next.index : body.length;
  const before = body.slice(0, at).replace(/\s+$/, '');
  return before + '\n\n' + block + (next ? '\n\n' + body.slice(at) : '\n');
}

/** The published block, or an error when GitHub left any reference local. */
export function publishedBlock(body, tour) {
  const [open, close] = markers(tour);
  const start = body.indexOf(open), end = body.indexOf(close, start);
  if (start === -1 || end === -1) throw new Error('The edited description has no proof block for ' + tour);
  const block = body.slice(start, end + close.length);
  const references = [...block.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map(match => match[1]);
  const bare = block.split(/\n\s*\n/).map(part => part.trim()).filter(part => /^https:\/\/\S+$/.test(part));
  if (references.some(reference => !/^https:\/\//.test(reference))) throw new Error('GitHub did not replace every attachment reference');
  if (references.length + bare.length < 2) throw new Error('The edited description is missing attachments');
  return block;
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
  return { report, attachments: ['video.mp4', 'contact-sheet.png', ...report.steps.map(step => step.image)] };
}

/** Uploads a proven recording into the pull request description through gh --attach. */
export async function publishProof(options) {
  try { return await attachProof(options); }
  catch (error) { throw new Error(diagnosticText(error.message)); }
}

async function attachProof({ pr, tour, cwd = root, repo, dryRun = false, proofRoot = join(cwd, '.proof'), gh = runGh }) {
  repo ??= JSON.parse(await readFile(join(cwd, 'workflow.json'), 'utf8')).tracker.repo;
  validatePublish({ pr, tour, repo });
  const source = join(proofRoot, tour);
  if ((await lstat(source)).isSymbolicLink()) throw new Error('Proof directory must not be a symbolic link');
  const { report, attachments } = await proofFiles(source, tour);
  validateCheckout(report.checkout);
  if (report.checkout.commit !== git(cwd, ['rev-parse', 'HEAD'])) throw new Error('Proof checkout differs from HEAD; record again before publishing');
  if (!gh(['pr', 'edit', '--help'], { cwd: source }).includes('--attach')) throw new Error('This gh cannot upload attachments; install a release with "gh pr edit --attach"');
  const view = ['pr', 'view', String(pr), '--repo', repo, '--json', 'body', '--jq', '.body'];
  const block = proofBlock({ tour, steps: report.steps, commit: report.checkout.commit });
  const body = withProof(gh(view, { cwd: source }).replace(/\n$/, ''), tour, block);
  if (dryRun) return { dryRun, markdown: '**Dry run: not published.** References are local until gh uploads them.\n\n' + block + '\n' };
  const temp = await mkdtemp(join(tmpdir(), 'pichamber-proof-publish-'));
  try {
    const file = join(temp, 'body.md');
    await writeFile(file, body);
    gh(['pr', 'edit', String(pr), '--repo', repo, '--body-file', file, ...attachments.flatMap(name => ['--attach', './' + name])], { cwd: source });
  } finally { await rm(temp, { recursive: true, force: true }); }
  return { dryRun, markdown: publishedBlock(gh(view, { cwd: source }), tour) + '\n' };
}

async function main() {
  const args = process.argv.slice(2).filter((arg, index) => !(index === 0 && arg === '--'));
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    repo: { type: 'string' }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) { console.log(usage); return; }
  if (positionals.length !== 2) throw new Error('PR and tour required; see --help');
  const result = await publishProof({ pr: positionals[0], tour: positionals[1], cwd: root,
    repo: values.repo || process.env.PROOF_REPO, dryRun: values['dry-run'] || false });
  process.stdout.write(result.markdown);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.code?.startsWith('ERR_PARSE_ARGS') ? 'Usage: ' + usage + ' (' + diagnosticText(error.message).replace(/\s+/g, ' ') + ')' : diagnosticText(error.message)); process.exitCode = 1; });
