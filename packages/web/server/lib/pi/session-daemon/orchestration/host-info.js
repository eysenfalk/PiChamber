import { execFile } from 'node:child_process';
import { cpus, freemem, loadavg, totalmem } from 'node:os';
import { join } from 'node:path';

import { createPiSettingsStore, resolveOrchestrationSettings } from '../../settings-store.js';

/** Host load and memory, so an orchestrator can decide whether to start more work. */
export const readHostStatus = () => {
  const [load1, load5, load15] = loadavg();
  return {
    cpuCount: cpus().length,
    loadAverage: { '1m': load1, '5m': load5, '15m': load15 },
    memory: { freeBytes: freemem(), totalBytes: totalmem() },
  };
};

/** Current git branch of a directory, or undefined outside a work tree. */
export const readGitBranch = (cwd) => new Promise((resolve) => {
  execFile('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 2_000 }, (error, stdout) => {
    const branch = typeof stdout === 'string' ? stdout.trim() : '';
    resolve(error || !branch ? undefined : branch);
  });
});

/** `owner/repo` of a directory's `origin` remote, or undefined when there is none. */
export const readGitRepository = (cwd) => new Promise((resolve) => {
  execFile('git', ['-C', cwd, 'remote', 'get-url', 'origin'], { timeout: 2_000 }, (error, stdout) => {
    const match = typeof stdout === 'string' ? stdout.trim().match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/) : null;
    resolve(error || !match ? undefined : match[1]);
  });
});

/** Orchestration settings from the PiChamber sidecar, merged over the defaults. */
export const createOrchestrationSettingsReader = ({ dataDir }) => {
  const store = createPiSettingsStore({ file: join(dataDir, 'pi', 'settings.json') });
  return async () => resolveOrchestrationSettings(await store.read());
};
