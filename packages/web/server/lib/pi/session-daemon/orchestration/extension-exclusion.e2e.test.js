import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createPiSessionRuntime } from '../session-daemon.js';

// Issue #151: a worker profile's `excludeExtensions` must keep an excluded
// extension from running at all, whether the pattern names its path or the
// package source it comes from. Each probe extension logs when its factory
// runs and when its event listener runs; the kept one exposes the shared
// event bus so the test can emit an event every extension listens for.

const probe = (name, { emitter = false } = {}) => `
export default function (pi) {
  const log = globalThis.__exclusionProbe ??= { events: [] };
  log.events.push('${name} FACTORY RAN');
  pi.events.on('probe', () => log.events.push('${name} HANDLER RAN'));
  ${emitter ? 'log.emit = (name) => pi.events.emit(name, {});' : ''}
  pi.registerTool({
    name: '${name}_tool',
    label: '${name}',
    description: 'Probe tool.',
    parameters: { type: 'object', properties: {} },
    async execute() { return { content: [{ type: 'text', text: '${name}' }], details: {} }; },
  });
}
`;

describe('excluded extensions of a worker profile', () => {
  let root;
  let runtime;

  afterEach(async () => {
    await runtime?.dispose();
    runtime = undefined;
    delete globalThis.__exclusionProbe;
    if (root) await rm(root, { recursive: true, force: true });
  });

  const setup = async (profile) => {
    root = await mkdtemp(join(tmpdir(), 'pichamber-extension-exclusion-'));
    const cwd = join(root, 'project');
    const agentDir = join(root, 'agent');
    const packageDir = join(root, 'probe-package');
    await mkdir(cwd, { recursive: true });
    await mkdir(join(agentDir, 'extensions'), { recursive: true });
    await mkdir(packageDir, { recursive: true });
    await writeFile(join(agentDir, 'extensions', 'kept.ts'), probe('kept', { emitter: true }));
    await writeFile(join(agentDir, 'extensions', 'by-path.ts'), probe('path'));
    await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: 'probe-package', pi: { extensions: ['./index.ts'] } }));
    await writeFile(join(packageDir, 'index.ts'), probe('package'));
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ packages: [packageDir] }));
    const inline = (pi) => { pi.registerTool({ name: 'inline_tool', label: 'inline', description: 'Inline probe.', parameters: { type: 'object', properties: {} }, async execute() { return { content: [], details: {} }; } }); };
    runtime = await createPiSessionRuntime({ cwd, agentDir }, { extensionFactories: [inline], workerProfile: () => profile(packageDir) });
    globalThis.__exclusionProbe.emit('probe');
    return { tools: runtime.session.getAllTools().map((tool) => tool.name), events: globalThis.__exclusionProbe.events };
  };

  it('never runs an extension excluded by path or by package source, and keeps the others', async () => {
    const { tools, events } = await setup((packageDir) => ({ name: 'read-only', excludeTools: [], excludeExtensions: ['*/by-path.ts', packageDir] }));
    expect(events.filter((event) => !event.startsWith('kept'))).toEqual([]);
    expect(events).toEqual(['kept FACTORY RAN', 'kept HANDLER RAN']);
    expect(tools).toEqual(expect.arrayContaining(['kept_tool', 'inline_tool']));
    expect(tools).not.toContain('path_tool');
    expect(tools).not.toContain('package_tool');
  });

  it('loads every extension for a profile without exclusions', async () => {
    const { tools, events } = await setup(() => ({ name: 'full', excludeTools: [], excludeExtensions: [] }));
    expect(events).toEqual(expect.arrayContaining(['path HANDLER RAN', 'package HANDLER RAN', 'kept HANDLER RAN']));
    expect(tools).toEqual(expect.arrayContaining(['kept_tool', 'path_tool', 'package_tool', 'inline_tool']));
  });
});
