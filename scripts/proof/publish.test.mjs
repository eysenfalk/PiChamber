import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishProof, publishMarkdown, validatePublish, resolveRemoteUrl } from './publish.mjs';

const temps = [];
const identity = { GIT_AUTHOR_NAME: 'Proof test', GIT_AUTHOR_EMAIL: 'proof@example.invalid', GIT_COMMITTER_NAME: 'Proof test', GIT_COMMITTER_EMAIL: 'proof@example.invalid' };
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...identity }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
afterEach(async () => { for (const path of temps.splice(0)) await rm(path, { recursive: true, force: true }); });
async function setup() {
  const temp = await mkdtemp(join(tmpdir(), 'proof-publish-test-')); temps.push(temp);
  const cwd = join(temp, 'host'), remote = join(temp, 'remote.git');
  await mkdir(cwd); git(cwd, ['init', '--quiet']); git(temp, ['init', '--quiet', '--bare', remote]);
  await writeFile(join(cwd, 'workflow.json'), JSON.stringify({ tracker: { repo: 'eysenfalk/PiChamber' } }));
  await writeFile(join(cwd, '.gitignore'), '.proof/\n');
  git(cwd, ['add', '.']); git(cwd, ['commit', '--quiet', '-m', 'Host source']);
  const proof = join(cwd, '.proof/fixture'); await mkdir(proof, { recursive: true });
  const steps = [{ caption: 'A complete screenshot', image: '01.png' }];
  await writeFile(join(proof, 'report.json'), JSON.stringify({ status: 'proven', tour: 'fixture', steps, checkout: { commit: git(cwd, ['rev-parse', 'HEAD']), dirty: false } }));
  for (const file of ['01.png', 'contact-sheet.png', 'video.mp4', 'index.md']) await writeFile(join(proof, file), file + ' fixture bytes');
  return { cwd, remote, proof, steps };
}
async function publish(options) {
  const previous = Object.fromEntries(Object.keys(identity).map(key => [key, process.env[key]]));
  Object.assign(process.env, identity);
  try { return await publishProof(options); }
  finally { for (const key of Object.keys(identity)) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } }
}

describe('publish.mjs local bare remote only', () => {
  test('relative file remotes resolve against host; HTTPS and SCP SSH remotes retain their meaning', () => {
    expect(resolveRemoteUrl('../bare.git', '/tmp/host')).toBe('/tmp/bare.git');
    expect(resolveRemoteUrl('git@github.com:owner/repo.git', '/tmp/host')).toBe('git@github.com:owner/repo.git');
    expect(resolveRemoteUrl('https://github.com/owner/repo.git', '/tmp/host')).toBe('https://github.com/owner/repo.git');
  });
  test('first publish is orphaned, preserves clean host/index/HEAD/worktrees and prints raw Markdown', async () => {
    const { cwd, remote } = await setup();
    const before = { status: git(cwd, ['status', '--porcelain']), head: git(cwd, ['rev-parse', 'HEAD']), trees: git(cwd, ['worktree', 'list', '--porcelain']) };
    expect(before.status).toBe('');
    const result = await publish({ cwd, remote, pr: 27, tour: 'fixture' });
    const files = git(remote, ['ls-tree', '-r', '--name-only', 'proofs']).split('\n');
    expect(files).toEqual(['01.png', 'contact-sheet.png', 'index.md', 'report.json', 'video.mp4'].map(file => 'pr-27/fixture/' + file));
    expect(git(remote, ['rev-list', '--parents', '-n', '1', 'proofs']).split(' ')).toHaveLength(1);
    expect(git(remote, ['rev-parse', 'proofs'])).toBe(result.commit);
    expect(result.markdown).toContain('![A complete screenshot](https://raw.githubusercontent.com/eysenfalk/PiChamber/' + result.commit + '/pr-27/fixture/01.png)');
    expect(result.markdown).toContain('[Video](https://raw.githubusercontent.com/eysenfalk/PiChamber/' + result.commit + '/pr-27/fixture/video.mp4)');
    expect({ status: git(cwd, ['status', '--porcelain']), head: git(cwd, ['rev-parse', 'HEAD']), trees: git(cwd, ['worktree', 'list', '--porcelain']) }).toEqual(before);
  });
  test('later publish appends, preserves unrelated proofs, replaces one tour, and identical retry adds no commit', async () => {
    const { cwd, remote, proof } = await setup();
    const first = await publish({ cwd, remote, pr: 27, tour: 'fixture' });
    await publish({ cwd, remote, pr: 28, tour: 'fixture' });
    await writeFile(join(proof, '01.png'), 'updated fixture');
    const changed = await publish({ cwd, remote, pr: 27, tour: 'fixture' });
    expect(git(remote, ['show', 'proofs:pr-27/fixture/01.png'])).toBe('updated fixture');
    expect(git(remote, ['show', 'proofs:pr-28/fixture/01.png'])).toBe('01.png fixture bytes');
    expect(git(remote, ['rev-list', '--max-parents=0', 'proofs'])).toBe(first.commit);
    expect((await publish({ cwd, remote, pr: 27, tour: 'fixture' })).commit).toBe(changed.commit);
    expect(git(cwd, ['status', '--porcelain'])).toBe('');
  });
  test('dry run never pushes, whether proofs exists or not, and labels Markdown as unpublished', async () => {
    const { cwd, remote } = await setup();
    const result = await publish({ cwd, remote, pr: 27, tour: 'fixture', dryRun: true });
    expect(git(remote, ['for-each-ref', '--format=%(refname)', 'refs/heads'])).toBe('');
    expect(result.markdown).toContain('Dry run: not published');
    await publish({ cwd, remote, pr: 27, tour: 'fixture' });
    const before = git(remote, ['rev-parse', 'proofs']);
    await publish({ cwd, remote, pr: 29, tour: 'fixture', dryRun: true });
    expect(git(remote, ['rev-parse', 'proofs'])).toBe(before);
    expect(git(cwd, ['status', '--porcelain'])).toBe('');
  });
  test('not-proven, missing, unexpected and symlink artifacts cannot be published', async () => {
    const { cwd, remote, proof } = await setup();
    await writeFile(join(proof, 'report.json'), JSON.stringify({ status: 'not-proven', tour: 'fixture', steps: [] }));
    await expect(publish({ cwd, remote, pr: 27, tour: 'fixture' })).rejects.toThrow('complete proven');
    await writeFile(join(proof, 'report.json'), JSON.stringify({ status: 'proven', tour: 'fixture', steps: [{ caption: 'x', image: '01.png' }] }));
    await writeFile(join(proof, '01-not-proven.png'), 'failed');
    await expect(publish({ cwd, remote, pr: 27, tour: 'fixture' })).rejects.toThrow('Unexpected proof files');
    await rm(join(proof, '01-not-proven.png')); await rm(join(proof, 'video.mp4'));
    await expect(publish({ cwd, remote, pr: 27, tour: 'fixture' })).rejects.toThrow();
    await symlink(join(proof, '01.png'), join(proof, 'video.mp4'));
    await expect(publish({ cwd, remote, pr: 27, tour: 'fixture' })).rejects.toThrow('unsafe artifact');
  });
  test('a rejected push leaves remote and host untouched', async () => {
    const { cwd, remote } = await setup();
    await writeFile(join(remote, 'hooks/pre-receive'), '#!/bin/sh\necho "failed https://user:SECRETTOKEN@localhost/x" >&2\nexit 1\n', { mode: 0o755 });
    try { await publish({ cwd, remote, pr: 27, tour: 'fixture' }); throw new Error('Expected rejected push'); }
    catch (error) { expect(error.message).toContain('git push failed'); expect(error.message).not.toContain('SECRETTOKEN'); }
    expect(git(remote, ['for-each-ref', '--format=%(refname)', 'refs/heads'])).toBe('');
    expect(git(cwd, ['status', '--porcelain'])).toBe('');
  });
  test('invalid identifiers and remote options fail before git; configurable repo controls URLs', () => {
    for (const bad of [{ pr: '-1' }, { tour: '../bad' }, { repo: 'bad' }, { remote: '--upload-pack=bad' }]) {
      expect(() => validatePublish({ pr: 27, tour: 'fixture', repo: 'eysenfalk/PiChamber', remote: 'origin', ...bad })).toThrow();
    }
    expect(publishMarkdown({ pr: 1, tour: 'fixture', repo: 'other/fork', dryRun: true, steps: [{ caption: '[safe]', image: '01.png' }] })).toContain('https://raw.githubusercontent.com/other/fork/proofs/pr-1/fixture/01.png');
  });
});

test('publish.mjs reviewer credentialed ls-remote probe throws no credentials, and CLI argument errors redact too', async () => {
  const { cwd } = await setup();
  try { await publish({ cwd, remote: 'https://user:SECRETTOKEN@127.0.0.1:9/x.git', pr: 27, tour: 'fixture' }); throw new Error('Expected git failure'); }
  catch (error) {
    expect(error.message).toContain('git ls-remote failed');
    expect(error.message).not.toContain('SECRETTOKEN');
    expect(error.message).not.toContain('user:');
    expect(error.message).not.toContain('Command failed:');
  }
  const result = spawnSync('node', [new URL('./publish.mjs', import.meta.url).pathname, '--https://user:SECRETTOKEN@127.0.0.1:9/x.git'], { encoding: 'utf8' });
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('Usage:');
  expect(result.stderr).not.toContain('SECRETTOKEN');
});

test('publish.mjs refuses a proof from another source commit before contacting a remote', async () => {
  const { cwd, proof, remote } = await setup();
  const report = JSON.parse(await readFile(join(proof, 'report.json'), 'utf8'));
  report.checkout.commit = 'a'.repeat(40);
  await writeFile(join(proof, 'report.json'), JSON.stringify(report));
  await expect(publish({ cwd, remote, pr: 27, tour: 'fixture' })).rejects.toThrow('differs from HEAD');
  expect(git(remote, ['for-each-ref', '--format=%(refname)', 'refs/heads'])).toBe('');
});

test('publish.mjs explicit author/committer and unsigned commits ignore global signing and identity', async () => {
  const { cwd, remote } = await setup();
  const config = join(cwd, 'host-global-config');
  await writeFile(config, '[commit]\n  gpgsign = true\n[user]\n  name = Wrong global identity\n  email = wrong@example.invalid\n');
  const previous = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = config;
  try {
    const result = await publishProof({ cwd, remote, pr: 27, tour: 'fixture' });
    expect(git(remote, ['show', '-s', '--format=%an <%ae> / %cn <%ce>', result.commit])).toBe('PiChamber proof recorder <proof@pichamber.invalid> / PiChamber proof recorder <proof@pichamber.invalid>');
  } finally { if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = previous; }
});

test('publish.mjs successful Markdown is pinned, dry-run links remain explicitly mutable and captions redact credentials', () => {
  const commit = 'b'.repeat(40), steps = [{ caption: 'See https://user:SECRETTOKEN@localhost/x', image: '01.png' }];
  const options = { pr: 27, tour: 'fixture', repo: 'eysenfalk/PiChamber', steps, commit };
  const markdown = publishMarkdown(options);
  expect(markdown).toContain('/' + commit + '/pr-27/fixture/');
  expect(markdown).not.toContain('SECRETTOKEN');
  expect(publishMarkdown({ ...options, dryRun: true })).toContain('/proofs/pr-27/fixture/');
  expect(() => publishMarkdown({ ...options, commit: undefined })).toThrow('commit SHA');
});
