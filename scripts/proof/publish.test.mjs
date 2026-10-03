import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishProof, proofBlock, publishedBlock, validatePublish, withProof } from './publish.mjs';

const temps = [];
const identity = { GIT_AUTHOR_NAME: 'Proof test', GIT_AUTHOR_EMAIL: 'proof@example.invalid', GIT_COMMITTER_NAME: 'Proof test', GIT_COMMITTER_EMAIL: 'proof@example.invalid' };
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...identity }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
afterEach(async () => { for (const path of temps.splice(0)) await rm(path, { recursive: true, force: true }); });

const description = '## Plan\n\nDo it.\n\n## Verification\n\nManual steps.\n\n## Review\n\nLater.';

async function setup() {
  const temp = await mkdtemp(join(tmpdir(), 'proof-publish-test-')); temps.push(temp);
  const cwd = join(temp, 'host');
  await mkdir(cwd); git(cwd, ['init', '--quiet']);
  await writeFile(join(cwd, 'workflow.json'), JSON.stringify({ tracker: { repo: 'eysenfalk/PiChamber' } }));
  await writeFile(join(cwd, '.gitignore'), '.proof/\n');
  git(cwd, ['add', '.']); git(cwd, ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Host source']);
  const proof = join(cwd, '.proof/fixture'); await mkdir(proof, { recursive: true });
  const steps = [{ caption: 'A complete screenshot', image: '01.png' }];
  await writeFile(join(proof, 'report.json'), JSON.stringify({ status: 'proven', tour: 'fixture', steps, checkout: { commit: git(cwd, ['rev-parse', 'HEAD']), dirty: false } }));
  for (const file of ['01.png', 'contact-sheet.png', 'video.mp4', 'index.md']) await writeFile(join(proof, file), file + ' fixture bytes');
  return { cwd, proof, steps };
}

/** A synchronous fake gh, like execFileSync: `pr edit --attach` rewrites ./name references and records calls. */
function syncGh(options) {
  const calls = [];
  let body = options?.body ?? description;
  const gh = (args, { cwd }) => {
    calls.push({ args, cwd });
    if (args.includes('--help')) return options?.noAttach ? 'no such flag' : '      --attach file   Attach an image or video file';
    if (args[1] === 'view') return body + '\n';
    if (args[1] === 'edit') {
      if (options?.fail) throw new Error(options.fail);
      const edited = execFileSync('cat', [args[args.indexOf('--body-file') + 1]], { encoding: 'utf8' });
      const attached = args.flatMap((arg, index) => arg === '--attach' ? [args[index + 1]] : []);
      body = attached.reduce((text, name) => name.endsWith('.mp4')
        ? text.replace('![](' + name + ')', 'https://github.com/user-attachments/assets/video-id')
        : text.replaceAll('](' + name + ')', '](https://github.com/user-attachments/assets/' + name.slice(2) + ')'), edited);
      return '';
    }
    throw new Error('unexpected gh call');
  };
  return { gh, calls, body: () => body };
}

describe('publish.mjs attaches proof through gh', () => {
  test('uploads every artifact from the tour directory and returns the hosted block', async () => {
    const { cwd, proof } = await setup();
    const fake = syncGh();
    const before = { status: git(cwd, ['status', '--porcelain']), head: git(cwd, ['rev-parse', 'HEAD']) };
    const result = await publishProof({ cwd, pr: 27, tour: 'fixture', gh: fake.gh });
    const edit = fake.calls.find(call => call.args[1] === 'edit' && !call.args.includes('--help'));
    expect(edit.cwd).toBe(proof);
    expect(edit.args.slice(0, 4)).toEqual(['pr', 'edit', '27', '--repo']);
    expect(edit.args.filter((arg, index) => edit.args[index - 1] === '--attach')).toEqual(['./video.mp4', './contact-sheet.png', './01.png']);
    expect(result.markdown).toContain('\n\nhttps://github.com/user-attachments/assets/video-id\n\n');
    expect(result.markdown).toContain('![A complete screenshot](https://github.com/user-attachments/assets/01.png)');
    expect(result.markdown).not.toContain('](./');
    expect(fake.body()).toContain('## Plan\n\nDo it.\n\n## Verification\n\nManual steps.\n\n<!-- proof:fixture -->');
    expect(fake.body()).toContain('<!-- /proof:fixture -->\n\n## Review\n\nLater.');
    expect({ status: git(cwd, ['status', '--porcelain']), head: git(cwd, ['rev-parse', 'HEAD']) }).toEqual(before);
  });

  test('republishing replaces only its own tour block and keeps other text and tours', async () => {
    const { cwd } = await setup();
    const other = '<!-- proof:other -->\n\nold other\n\n<!-- /proof:other -->';
    const fake = syncGh({ body: description.replace('Manual steps.', 'Manual steps.\n\n' + other) });
    await publishProof({ cwd, pr: 27, tour: 'fixture', gh: fake.gh });
    const first = fake.body();
    await publishProof({ cwd, pr: 27, tour: 'fixture', gh: fake.gh });
    expect(fake.body()).toBe(first);
    expect(fake.body().split('<!-- proof:fixture -->')).toHaveLength(2);
    expect(fake.body()).toContain(other);
  });

  test('dry run reads the description but never edits it', async () => {
    const { cwd } = await setup();
    const fake = syncGh();
    const result = await publishProof({ cwd, pr: 27, tour: 'fixture', dryRun: true, gh: fake.gh });
    expect(fake.calls.map(call => call.args.slice(0, 2).join(' '))).toEqual(['pr edit', 'pr view']);
    expect(fake.calls.some(call => call.args[1] === 'edit' && call.args[2] !== '--help')).toBe(false);
    expect(result.markdown).toContain('Dry run: not published');
    expect(fake.body()).toBe(description);
  });

  test('not-proven, missing, unexpected and symlink artifacts are refused before gh is called', async () => {
    const { cwd, proof } = await setup();
    const fake = syncGh();
    await writeFile(join(proof, 'report.json'), JSON.stringify({ status: 'not-proven', tour: 'fixture', steps: [] }));
    await expect(publishProof({ cwd, pr: 27, tour: 'fixture', gh: fake.gh })).rejects.toThrow('complete proven');
    await writeFile(join(proof, 'report.json'), JSON.stringify({ status: 'proven', tour: 'fixture', steps: [{ caption: 'x', image: '01.png' }] }));
    await writeFile(join(proof, '01-not-proven.png'), 'failed');
    await expect(publishProof({ cwd, pr: 27, tour: 'fixture', gh: fake.gh })).rejects.toThrow('Unexpected proof files');
    await rm(join(proof, '01-not-proven.png')); await rm(join(proof, 'video.mp4'));
    await expect(publishProof({ cwd, pr: 27, tour: 'fixture', gh: fake.gh })).rejects.toThrow();
    await symlink(join(proof, '01.png'), join(proof, 'video.mp4'));
    await expect(publishProof({ cwd, pr: 27, tour: 'fixture', gh: fake.gh })).rejects.toThrow('unsafe artifact');
    expect(fake.calls).toEqual([]);
  });

  test('a proof from another source commit is refused before gh is called', async () => {
    const { cwd, proof } = await setup();
    const fake = syncGh();
    const report = JSON.parse(await readFile(join(proof, 'report.json'), 'utf8'));
    report.checkout.commit = 'a'.repeat(40);
    await writeFile(join(proof, 'report.json'), JSON.stringify(report));
    await expect(publishProof({ cwd, pr: 27, tour: 'fixture', gh: fake.gh })).rejects.toThrow('differs from HEAD');
    expect(fake.calls).toEqual([]);
  });

  test('a gh without --attach, a description without Verification and a failed upload all fail visibly', async () => {
    const { cwd } = await setup();
    await expect(publishProof({ cwd, pr: 27, tour: 'fixture', gh: syncGh({ noAttach: true }).gh })).rejects.toThrow('cannot upload attachments');
    await expect(publishProof({ cwd, pr: 27, tour: 'fixture', gh: syncGh({ body: '## Plan\n\nx' }).gh })).rejects.toThrow('no "## Verification" section');
    const failed = syncGh({ fail: 'gh pr edit failed: upload https://user:SECRETTOKEN@example.invalid rejected' });
    try { await publishProof({ cwd, pr: 27, tour: 'fixture', gh: failed.gh }); throw new Error('Expected failure'); }
    catch (error) { expect(error.message).toContain('gh pr edit failed'); expect(error.message).not.toContain('SECRETTOKEN'); }
  });
});

describe('publish.mjs description editing', () => {
  const block = proofBlock({ tour: 'fixture', steps: [{ caption: 'See [x] https://user:SECRETTOKEN@localhost/x', image: '01.png' }], commit: 'b'.repeat(40) });
  test('the block references local files, stands the video alone and redacts captions', () => {
    expect(block).toContain('\n\n![](./video.mp4)\n\n');
    expect(block).toContain('](./01.png)');
    expect(block).toContain('`bbbbbbbbbbbb`');
    expect(block).not.toContain('SECRETTOKEN');
    expect(block).toContain('See \\[x\\]');
  });
  test('appends at the end of Verification, also when it is the last section', () => {
    expect(withProof('## Verification\n\nx\n', 'fixture', block)).toBe('## Verification\n\nx\n\n' + block + '\n');
    expect(() => withProof('## Plan', 'fixture', block)).toThrow('Verification');
    expect(() => withProof('## Verification\n\n<!-- proof:fixture -->', 'fixture', block)).toThrow('unterminated');
  });
  test('a block with local references left is not reported as published', () => {
    expect(() => publishedBlock('## Verification\n\n' + block, 'fixture')).toThrow('did not replace');
    expect(() => publishedBlock('nothing', 'fixture')).toThrow('no proof block');
  });
});

test('publish.mjs validates identifiers, and CLI argument errors redact credentials', () => {
  for (const bad of [{ pr: '-1' }, { pr: '0' }, { tour: '../bad' }, { repo: 'bad' }, { repo: 'a/..' }]) {
    expect(() => validatePublish({ pr: 27, tour: 'fixture', repo: 'eysenfalk/PiChamber', ...bad })).toThrow();
  }
  const result = spawnSync('node', [new URL('./publish.mjs', import.meta.url).pathname, '--https://user:SECRETTOKEN@127.0.0.1:9/x.git'], { encoding: 'utf8' });
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('Usage:');
  expect(result.stderr).not.toContain('SECRETTOKEN');
});
