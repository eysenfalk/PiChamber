import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createOrchestrationRegistryStore } from './registry-store.js';

const tempFile = async () => join(await mkdtemp(join(tmpdir(), 'pichamber-orch-registry-')), 'pi', 'orchestration-registry.json');

describe('orchestration registry store', () => {
  it('reads a missing file as an empty registry', async () => {
    const store = createOrchestrationRegistryStore({ file: await tempFile() });
    await expect(store.read()).resolves.toEqual({
      version: 1,
      importedFromLineage: [],
      owners: {},
      requestKeys: {},
      operations: {},
      workers: {},
      pendingEvents: {},
    });
  });

  it('serialises concurrent updates so no change is lost', async () => {
    const file = await tempFile();
    const store = createOrchestrationRegistryStore({ file });
    await Promise.all(Array.from({ length: 20 }, (_, index) => store.update((document) => {
      document.workers[`w${index}`] = { state: 'active' };
    })));
    expect(Object.keys((await store.read()).workers)).toHaveLength(20);
    // A second store on the same file (another daemon instance) sees the writes.
    const other = createOrchestrationRegistryStore({ file });
    expect(Object.keys((await other.read()).workers)).toHaveLength(20);
  });

  it('keeps unknown keys and leaves the file untouched when a change throws', async () => {
    const file = await tempFile();
    const store = createOrchestrationRegistryStore({ file });
    await store.update((document) => {
      document.futureField = { kept: true };
      document.workers.w1 = { state: 'active', futureWorkerField: 1 };
    });
    const before = await readFile(file, 'utf8');
    await expect(store.update((document) => {
      document.workers.w1.state = 'done';
      throw Object.assign(new Error('refused'), { code: 'ORCHESTRATION_LIMIT' });
    })).rejects.toMatchObject({ code: 'ORCHESTRATION_LIMIT' });
    expect(await readFile(file, 'utf8')).toBe(before);
    await expect(store.update((document) => document.workers.w1.state)).resolves.toBe('active');
    expect(await store.read()).toMatchObject({ futureField: { kept: true }, workers: { w1: { futureWorkerField: 1 } } });
  });

  it('fails on a malformed file instead of treating it as empty', async () => {
    const file = await tempFile();
    const store = createOrchestrationRegistryStore({ file });
    await store.update(() => {});
    await writeFile(file, 'not-json');
    await expect(store.read()).rejects.toMatchObject({ code: 'ORCHESTRATION_REGISTRY_INVALID' });
    await expect(store.update(() => {})).rejects.toMatchObject({ code: 'ORCHESTRATION_REGISTRY_INVALID' });
    await writeFile(file, JSON.stringify({ version: 2 }));
    await expect(store.read()).rejects.toMatchObject({ code: 'ORCHESTRATION_REGISTRY_INVALID' });
  });
});
