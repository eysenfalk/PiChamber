import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import config from './vite.config';
import { BUILD_INFO_FILE, isBuildStamp } from './server/lib/build-info.js';

describe('Vite development proxy', () => {
  it('rewrites WebSocket origins to satisfy authenticated upstream origin checks', () => {
    const apiProxy = config.server?.proxy?.['/api'];

    expect(apiProxy).toMatchObject({
      rewriteWsOrigin: true,
      ws: true,
    });
  });
});

describe('Vite build stamp', () => {
  it('embeds the stamp in the UI bundle and writes the same stamp beside the build', () => {
    const embedded = JSON.parse(String(config.define?.__PICHAMBER_BUILD__));
    expect(isBuildStamp(embedded)).toBe(true);

    const plugin = (config.plugins ?? []).flat().find(
      (candidate) => candidate && typeof candidate === 'object' && 'name' in candidate && candidate.name === 'pichamber-build-info',
    ) as { generateBundle: (this: { emitFile: (file: { fileName: string; source: string }) => void }) => void } | undefined;
    expect(plugin).toBeDefined();
    const emitted: Array<{ fileName: string; source: string }> = [];
    plugin!.generateBundle.call({ emitFile: (file) => emitted.push(file) });
    expect(emitted).toHaveLength(1);
    expect(emitted[0].fileName).toBe(BUILD_INFO_FILE);
    expect(JSON.parse(emitted[0].source)).toEqual(embedded);
  });

  it('keeps the build-info file name the server reads', () => {
    const source = readFileSync(new URL('./server/lib/build-info.js', import.meta.url), 'utf8');
    expect(source).toContain("BUILD_INFO_FILE = 'build-info.json'");
  });
});
