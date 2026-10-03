import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { parse } from 'yaml';
import { SEED_MANIFEST } from '../lab/seed-spec.mjs';

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const image = read('lab/Containerfile');
const run = read('lab/run');
const pod = parse(read('lab/lab.yaml'));
const value = (name) => run.match(new RegExp(`^${name}=(.+)$`, 'm'))?.[1];
const cpus = (v) => String(v).endsWith('m') ? Number.parseFloat(v) / 1000 : Number(v);
const memoryMiB = (v) => {
  const match = String(v).match(/^([0-9.]+)(Mi|Gi|m|g)$/);
  if (!match) throw new Error(`Unknown memory unit: ${v}`);
  return Number(match[1]) * (['g', 'Gi'].includes(match[2]) ? 1024 : 1);
};

describe('proof lab repository rules', () => {
  test('the image Bun matches packageManager and CI, and Node matches CI', () => {
    const pkg = JSON.parse(read('package.json'));
    const ci = parse(read('.github/workflows/pr-checks.yml'));
    const steps = ci.jobs.checks.steps;
    const bun = steps.find((s) => s.with?.['bun-version']).with['bun-version'];
    const node = steps.find((s) => s.with?.['node-version']).with['node-version'];
    expect(pkg.packageManager).toBe(`bun@${bun}`);
    expect(image).toContain(`FROM docker.io/oven/bun:${bun} AS bun`);
    expect(image).toContain(`FROM docker.io/library/node:${node}-slim AS node`);
    expect(image).toContain('FROM docker.io/library/ubuntu:26.04');
    expect(image).toContain('libx264');
    expect(image).toContain('drawtext');
  });

  test('all lab pods plus infra fit the 4 CPU and 8 GiB budget, and build is bounded separately', () => {
    const manifests = readdirSync(new URL('../../lab/', import.meta.url)).filter((f) => /\.ya?ml$/.test(f));
    let cpu = cpus(value('infra_cpus')) + cpus(value('recorder_cpus'));
    expect(cpus(value('recorder_cpus'))).toBeGreaterThan(0);
    expect(memoryMiB(value('recorder_memory'))).toBeGreaterThan(0);
    let memory = memoryMiB(value('infra_memory')) + memoryMiB(value('recorder_memory'));
    for (const file of manifests) {
      const manifest = parse(read(`lab/${file}`));
      expect(manifest.kind).toBe('Pod');
      for (const container of [...(manifest.spec.initContainers ?? []), ...manifest.spec.containers]) {
        expect(container.resources?.limits?.cpu).toBeDefined();
        expect(container.resources?.limits?.memory).toBeDefined();
        cpu += cpus(container.resources.limits.cpu);
        memory += memoryMiB(container.resources.limits.memory);
      }
    }
    expect(cpu).toBeGreaterThan(0);
    expect(cpu).toBeLessThanOrEqual(4);
    expect(memory).toBeGreaterThan(0);
    expect(memory).toBeLessThanOrEqual(8192);
    expect(Number(value('build_cpus'))).toBeLessThanOrEqual(4);
    expect(memoryMiB(value('build_memory'))).toBeLessThanOrEqual(8192);
    expect(run).toContain('podman update --cpus="$infra_cpus" --memory="$infra_memory"');
    expect(run).toContain('--cpu-quota=$((build_cpus * 100000))');
    expect(run).toContain('--memory-swap="$build_memory"');
    expect(run).toContain('--cpus="$recorder_cpus" --memory="$recorder_memory" --memory-swap="$recorder_memory"');
    expect(run).toContain('podman update --memory-swap=3968m');
  });

  test('the runtime has only a read-only checkout and a volume, offline state and no privileges', () => {
    expect(pod.spec.volumes).toHaveLength(2);
    expect(pod.spec.volumes[0].hostPath.path).toBe('LAB_REPOSITORY');
    const server = pod.spec.containers[0];
    expect(server.volumeMounts.find((v) => v.name === 'repository').readOnly).toBe(true);
    expect(server.securityContext.allowPrivilegeEscalation).toBe(false);
    expect(server.securityContext.capabilities.drop).toEqual(['ALL']);
    expect(server.env.find((e) => e.name === 'PI_OFFLINE').value).toBe('1');
    expect(server.env.find((e) => e.name === 'HOME').value).toBe('/lab');
    expect(run).toContain('podman network create --internal');
    expect(run).toContain('--userns=keep-id');
    expect(run).toContain('--publish=127.0.0.1:3111:3000');
    expect(run).toContain('sha256sum "$root/lab/Containerfile"');
    expect(run).toContain('podman network rm');
    expect(run).toContain('podman volume rm');
    expect(run).toContain('--read-only --tmpfs=/tmp:rw,size=512m');
    expect(run).toContain('--volume="$root:/repo:ro" --volume="$root/.proof:/repo/.proof:rw"');
    expect(run).toContain('--url "http://$name:3000/" --chrome /repo/lab/chromium');
    expect(read('lab/chromium')).toContain('exec /usr/local/bin/chromium --no-sandbox "$@"');
    expect(read('scripts/proof/record.mjs')).not.toContain('--no-sandbox');
  });

  test('the recorder manifest matches the SDK seed constants and tools tests are in the CI test command', () => {
    expect(JSON.parse(read('lab/seed-manifest.json'))).toEqual(SEED_MANIFEST);
    const scripts = JSON.parse(read('package.json')).scripts;
    expect(scripts['test:tools']).toBe('bun test scripts/lab scripts/proof');
    expect(scripts.test).toBe('node scripts/lab/test-env.mjs --run');
    expect(read('scripts/lab/test-env.mjs')).toContain("'test:tools'");
  });
});
