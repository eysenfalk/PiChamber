import { expect, test } from 'bun:test';
import { mkdtemp, writeFile, readFile, rm, mkdir, symlink, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedTestEnv } from './test-env.mjs';
import { parse } from 'yaml';

const labRun = fileURLToPath(new URL('../../lab/run', import.meta.url));
const checkout = dirname(dirname(labRun));
const decoys = ['pod-pichamber-lab-other', 'network-unrelated', 'volume-pichamber-lab-state-2'];

for (const { empty, repeat, status, attempts, title } of [
  { empty: true, repeat: false, status: 0, attempts: 2, title: 'retries a failed removal of an empty pod and verifies cleanup' },
  { empty: false, repeat: false, status: 1, attempts: 1, title: 'keeps a removal failure with containers still present' },
  { empty: true, repeat: true, status: 1, attempts: 3, title: 'stops retrying after three attempts and reports the remaining pod' },
]) {
  test(`down ${title}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-run-'));
    try {
      for (const resource of ['pod-pichamber-lab', 'network-pichamber-lab', 'volume-pichamber-lab-state', ...decoys])
        await writeFile(join(root, resource), 'present');
      await writeFile(join(root, 'podman'), `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$FAKE_LAB/calls"
if [[ "$1" == info ]]; then echo true; exit; fi
kind="$1"; action="$2"; resource="\${!#}"
if [[ "$action" == exists ]]; then test -e "$FAKE_LAB/$kind-$resource"; exit; fi
if [[ "$action" == inspect ]]; then
  if [[ "$*" == *io.pichamber.lab.checkout* ]]; then echo "$FAKE_CHECKOUT"; else echo "$FAKE_CONTAINERS"; fi
  exit
fi
if [[ "$kind" == pod && ( "$FAKE_REPEAT" == 1 || ! -e "$FAKE_LAB/attempt" ) ]]; then
  touch "$FAKE_LAB/attempt"; echo 'rootless netns: kill network process: permission denied' >&2; exit 125
fi
rm -f "$FAKE_LAB/$kind-$resource"
`, { mode: 0o700 });
      const result = spawnSync('bash', [fileURLToPath(new URL('../../lab/run', import.meta.url)), 'down'], {
        env: { ...process.env, PATH: `${root}:${process.env.PATH}`, XDG_RUNTIME_DIR: root,
          FAKE_LAB: root, FAKE_CHECKOUT: checkout, FAKE_CONTAINERS: empty ? '0' : '1', FAKE_REPEAT: repeat ? '1' : '0' }, encoding: 'utf8', timeout: 5000,
      });
      expect(result.status).toBe(status);
      const calls = await readFile(join(root, 'calls'), 'utf8');
      expect(calls.split('\n').filter((line) => line.startsWith('pod rm'))).toHaveLength(attempts);
      expect(calls.includes('network rm pichamber-lab')).toBe(empty);
      expect(calls.includes('volume rm pichamber-lab-state')).toBe(empty);
      for (const line of calls.trim().split('\n')) {
        expect(line).not.toMatch(/prune|--all|--filter/);
        if (line.includes(' rm ')) expect(line).toMatch(/^(pod rm --force pichamber-lab|network rm pichamber-lab|volume rm pichamber-lab-state)$/);
      }
      for (const decoy of decoys) expect((await stat(join(root, decoy))).isFile()).toBe(true);
      if (!empty) expect(result.stderr).toContain('containers still present');
      if (repeat) expect(result.stderr).toContain('Left over: pod pichamber-lab');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test('the full test runner removes parent runtime selectors, not ordinary test configuration', () => {
  expect(isolatedTestEnv({ PATH: '/bin', PICHAMBER: '1', PICHAMBER_UI_PASSWORD: 'synthetic',
    PICHAMBER_DIST_DIR: '/fake', PI_PACKAGE_DIR: '/fake', ELECTRON_RUN_AS_NODE: '1', CI: 'true',
    PICHAMBER_TEST_RUNTIME: '/test-runtime' })).toEqual({ PATH: '/bin', CI: 'true', PICHAMBER_TEST_RUNTIME: '/test-runtime' });
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

for (const command of ['status', 'down']) {
  test(`${command} refuses a lab owned by another checkout without touching resources`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-owner-'));
    try {
      await writeFile(join(root, 'podman'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_LAB/calls"
if [[ "$1" == info ]]; then echo true; elif [[ "$2" == inspect ]]; then echo /other/checkout; fi
`, { mode: 0o700 });
      const result = spawnSync('bash', [labRun, command], {
        env: { ...process.env, PATH: `${root}:${process.env.PATH}`, XDG_RUNTIME_DIR: root, FAKE_LAB: root }, encoding: 'utf8', timeout: 5000,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Lab belongs to another checkout: /other/checkout');
      expect(await readFile(join(root, 'calls'), 'utf8')).not.toMatch(/ rm | ps /);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test('the lifecycle lock never opens a symlinked writable lock file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pichamber-lock-'));
  try {
    await writeFile(join(root, 'target'), 'untouched');
    await symlink(join(root, 'target'), join(root, 'pichamber-lab.lock'));
    await writeFile(join(root, 'podman'), '#!/usr/bin/env bash\nif [[ "$1" == info ]]; then echo true; else exit 1; fi\n', { mode: 0o700 });
    const result = spawnSync('bash', [labRun, 'down'], {
      env: { ...process.env, PATH: `${root}:${process.env.PATH}`, XDG_RUNTIME_DIR: root }, encoding: 'utf8', timeout: 5000,
    });
    expect(result.status).toBe(0);
    expect(await readFile(join(root, 'target'), 'utf8')).toBe('untouched');
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const mismatch of ['', 'server', 'infra']) {
  test(`up verifies applied server and infra limits${mismatch ? ` and cleans up a ${mismatch} mismatch` : ''}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-up-'));
    try {
      await mkdir(join(root, 'lab'));
      await mkdir(join(root, 'packages/web/dist'), { recursive: true });
      await writeFile(join(root, 'packages/web/dist/index.html'), 'built');
      await symlink(join(checkout, 'node_modules'), join(root, 'node_modules'));
      for (const file of ['run', 'lab.yaml', 'Containerfile']) await writeFile(join(root, 'lab', file), await readFile(join(checkout, 'lab', file)));
      const limits = parse(await readFile(join(root, 'lab/lab.yaml'), 'utf8')).spec.containers.find(c => c.name === 'server').resources.limits;
      const memory = Number.parseFloat(limits.memory) * 1024 ** 2;
      await writeFile(join(root, 'podman'), `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$FAKE_LAB/calls"
if [[ "$1" == info ]]; then echo true; exit; fi
if [[ "$1" == image ]]; then exit; fi
if [[ "$2" == exists ]]; then test -e "$FAKE_LAB/$1"; exit; fi
if [[ "$2" == create ]]; then touch "$FAKE_LAB/$1"; exit; fi
if [[ "$1 $2" == 'kube play' ]]; then touch "$FAKE_LAB/pod"; exit; fi
if [[ "$1 $2" == 'pod inspect' ]]; then
  if [[ "$*" == *io.pichamber.lab.checkout* ]]; then echo "$FAKE_LAB"; else echo infra; fi
  exit
fi
if [[ "$1" == inspect ]]; then
  if [[ "$2" == infra ]]; then expected='10000 100000 134217728 134217728'; kind=infra
  else expected="$FAKE_SERVER"; kind=server; fi
  if [[ "$kind" == "$FAKE_MISMATCH" ]]; then echo '0 0 0 0'; else echo "$expected"; fi
  exit
fi
if [[ "$2" == rm ]]; then rm -f "$FAKE_LAB/$1"; exit; fi
if [[ "$1" == logs ]]; then echo 'Lab ready:'; fi
`, { mode: 0o700 });
      const result = spawnSync('bash', [join(root, 'lab/run'), 'up'], {
        env: { ...process.env, PATH: `${root}:${process.env.PATH}`, XDG_RUNTIME_DIR: root, FAKE_LAB: root,
          FAKE_MISMATCH: mismatch, FAKE_SERVER: `${Math.round(Number(limits.cpu) * 100000)} 100000 ${memory} ${memory}` }, encoding: 'utf8', timeout: 10000,
      });
      expect(result.status).toBe(mismatch ? 1 : 0);
      const calls = await readFile(join(root, 'calls'), 'utf8');
      expect(calls).toContain(`update --memory-swap=${memory} pichamber-lab-server`);
      expect(calls).toContain('inspect pichamber-lab-server --format {{.HostConfig.CpuQuota}}');
      if (mismatch) {
        expect(result.stderr).toContain('resource limits not applied');
        expect(calls).toContain('pod rm --force pichamber-lab');
        expect(calls).toContain('network rm pichamber-lab');
        expect(calls).toContain('volume rm pichamber-lab-state');
      } else {
        expect(calls).toContain('inspect infra --format {{.HostConfig.CpuQuota}}');
        expect(result.stdout).toContain('http://127.0.0.1:3111');
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
