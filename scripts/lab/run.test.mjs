import { expect, test } from 'bun:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedTestEnv } from './test-env.mjs';

for (const { empty, repeat, status, attempts, title } of [
  { empty: true, repeat: false, status: 0, attempts: 2, title: 'retries a failed removal of an empty pod and verifies cleanup' },
  { empty: false, repeat: false, status: 1, attempts: 1, title: 'keeps a removal failure with containers still present' },
  { empty: true, repeat: true, status: 1, attempts: 3, title: 'stops retrying after three attempts and reports the remaining pod' },
]) {
  test(`down ${title}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-run-'));
    try {
      for (const kind of ['pod', 'network', 'volume']) await writeFile(join(root, kind), 'present');
      await writeFile(join(root, 'podman'), `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$FAKE_LAB/calls"
if [[ "$1" == info ]]; then echo true; exit; fi
kind="$1"; action="$2"
if [[ "$action" == exists ]]; then test -e "$FAKE_LAB/$kind"; exit; fi
if [[ "$action" == inspect ]]; then echo "$FAKE_CONTAINERS"; exit; fi
if [[ "$kind" == pod && ( "$FAKE_REPEAT" == 1 || ! -e "$FAKE_LAB/attempt" ) ]]; then
  touch "$FAKE_LAB/attempt"; echo 'rootless netns: kill network process: permission denied' >&2; exit 125
fi
rm -f "$FAKE_LAB/$kind"
`, { mode: 0o700 });
      const result = spawnSync('bash', [fileURLToPath(new URL('../../lab/run', import.meta.url)), 'down'], {
        env: { ...process.env, PATH: `${root}:${process.env.PATH}`, XDG_RUNTIME_DIR: root,
          FAKE_LAB: root, FAKE_CONTAINERS: empty ? '0' : '1', FAKE_REPEAT: repeat ? '1' : '0' }, encoding: 'utf8', timeout: 5000,
      });
      expect(result.status).toBe(status);
      const calls = await readFile(join(root, 'calls'), 'utf8');
      expect(calls.split('\n').filter((line) => line.startsWith('pod rm'))).toHaveLength(attempts);
      expect(calls.includes('network rm pichamber-lab')).toBe(empty);
      expect(calls.includes('volume rm pichamber-lab-state')).toBe(empty);
      if (!empty) expect(result.stderr).toContain('containers still present');
      if (repeat) expect(result.stderr).toContain('Left over: pod pichamber-lab');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test('the full test runner removes parent runtime selectors, not ordinary test configuration', () => {
  expect(isolatedTestEnv({ PATH: '/bin', PICHAMBER: '1', PICHAMBER_UI_PASSWORD: 'synthetic',
    PICHAMBER_DIST_DIR: '/fake', PI_PACKAGE_DIR: '/fake', ELECTRON_RUN_AS_NODE: '1', CI: 'true',
    PICHAMBER_TEST_RUNTIME: '/test-runtime' })).toEqual({ PATH: '/bin', CI: 'true' });
});

for (const exitCode of [0, 42]) {
  test(`record uses the lab-only container contract and preserves exit ${exitCode}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-record-'));
    try {
      await writeFile(join(root, 'podman'), `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$FAKE_LAB/calls"
if [[ "$1" == info ]]; then echo true; exit; fi
if [[ "$1" == inspect ]]; then
  if [[ "$*" == *State.Running* ]]; then echo true; else echo sha256:running-image; fi
  exit
fi
if [[ "$1" == run ]]; then exit "$FAKE_EXIT"; fi
`, { mode: 0o700 });
      const result = spawnSync('bash', [fileURLToPath(new URL('../../lab/run', import.meta.url)), 'record', 'lab'], {
        env: { ...process.env, PATH: `${root}:${process.env.PATH}`, XDG_RUNTIME_DIR: root,
          FAKE_LAB: root, FAKE_EXIT: String(exitCode), PROOF_URL: 'https://must-not-be-used.invalid' }, encoding: 'utf8', timeout: 5000,
      });
      expect(result.status).toBe(exitCode);
      const calls = await readFile(join(root, 'calls'), 'utf8');
      expect(calls).toContain('--network=pichamber-lab --userns=keep-id');
      expect(calls).toContain('--read-only --tmpfs=/tmp:rw,size=512m');
      expect(calls).toContain('--cpus=2 --memory=4096m --memory-swap=4096m');
      expect(calls).toContain(':/repo:ro');
      expect(calls).toContain('/.proof:/repo/.proof:rw');
      expect(calls).toContain('sha256:running-image node scripts/proof/record.mjs lab --url http://pichamber-lab:3000/ --chrome /repo/lab/chromium');
      expect(calls).not.toContain('must-not-be-used');
      expect(calls).toContain('rm --force pichamber-lab-recorder');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test('record rejects extra flags and unsupported tours before calling podman', () => {
  for (const args of [['record'], ['record', 'lab', '--url', 'http://example.invalid'], ['record', '../escape']]) {
    const result = spawnSync('bash', [fileURLToPath(new URL('../../lab/run', import.meta.url)), ...args], { encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage: lab/run');
  }
});

test('test-env uses the invoking Bun without depending on its directory in PATH', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pichamber-test-env-'));
  try {
    const bun = join(root, 'invoking-bun');
    await writeFile(bun, `#!/usr/bin/env bash
set -eu
[[ ! -v PICHAMBER_DIST_DIR && ! -v ELECTRON_RUN_AS_NODE ]]
command -v invoking-bun >/dev/null
printf '%s\\n' "$*" >> "$FAKE_LAB/calls"
`, { mode: 0o700 });
    const result = spawnSync('node', [fileURLToPath(new URL('./test-env.mjs', import.meta.url)), '--run'], {
      env: { ...process.env, npm_execpath: bun, FAKE_LAB: root, PICHAMBER_DIST_DIR: '/fake', ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8', timeout: 5000,
    });
    expect(result.status).toBe(0);
    expect((await readFile(join(root, 'calls'), 'utf8')).trim().split('\n')).toEqual([
      'run test:repo', 'run test:tools', 'run test:web', 'run test:ui', 'run test:electron',
    ]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
