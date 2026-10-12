import { ExtensionRunner } from '@earendil-works/pi-coding-agent';

// Extensions that wrap tool execution (pi-fabric) must patch the exact
// ExtensionRunner class that runs this daemon's sessions. The stock Pi CLI is
// a bundle, so they find its class through `process.argv[1]`; the daemon runs
// the unbundled SDK, so that lookup lands on a different copy of the class and
// no tool hooks ever initialize ("Pi tool write is unavailable until extension
// tool hooks initialize"). Extensions read this well-known registry first.
export const HOST_EXTENSION_RUNNERS_KEY = Symbol.for('pi-fabric.host-extension-runners.v1');

export function advertiseHostExtensionRunner(target = globalThis, Runner = ExtensionRunner) {
  const existing = target[HOST_EXTENSION_RUNNERS_KEY];
  const runners = existing instanceof Set ? existing : new Set();
  runners.add(Runner);
  target[HOST_EXTENSION_RUNNERS_KEY] = runners;
  return runners;
}
