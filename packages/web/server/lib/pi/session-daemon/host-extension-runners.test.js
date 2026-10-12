import { describe, expect, it } from 'vitest';
import { ExtensionRunner } from '@earendil-works/pi-coding-agent';

import { HOST_EXTENSION_RUNNERS_KEY, advertiseHostExtensionRunner } from './host-extension-runners.js';

describe('host extension runner advertisement', () => {
  it('registers the SDK ExtensionRunner that daemon sessions use', () => {
    const target = {};
    const runners = advertiseHostExtensionRunner(target);
    expect(target[HOST_EXTENSION_RUNNERS_KEY]).toBe(runners);
    expect([...runners]).toEqual([ExtensionRunner]);
  });

  it('keeps runners advertised by others and does not duplicate itself', () => {
    class Other {}
    const target = { [HOST_EXTENSION_RUNNERS_KEY]: new Set([Other]) };
    advertiseHostExtensionRunner(target);
    advertiseHostExtensionRunner(target);
    expect([...target[HOST_EXTENSION_RUNNERS_KEY]]).toEqual([Other, ExtensionRunner]);
  });

  it('is registered on globalThis once the session daemon module loads', async () => {
    await import('./session-daemon.js');
    expect(globalThis[HOST_EXTENSION_RUNNERS_KEY]?.has(ExtensionRunner)).toBe(true);
  });
});
