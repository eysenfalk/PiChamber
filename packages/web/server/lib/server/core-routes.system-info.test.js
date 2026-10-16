import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';

import { registerServerStatusRoutes } from './core-routes.js';

const listen = (app) => new Promise((resolve, reject) => {
  const server = app.listen(0, '127.0.0.1', () => resolve(server));
  server.once('error', reject);
});

describe('GET /api/system/info build stamps', () => {
  let server;
  afterEach(() => new Promise((resolve) => (server ? server.close(() => resolve()) : resolve())));

  const start = async (overrides) => {
    const app = express();
    registerServerStatusRoutes(app, {
      express,
      process,
      pichamberVersion: '1.0.3',
      runtimeName: 'web',
      serverStartedAt: '2026-10-04T09:00:00.000Z',
      gracefulShutdown: async () => {},
      getHealthSnapshot: () => ({}),
      ...overrides,
    });
    server = await listen(app);
    return `http://127.0.0.1:${server.address().port}/api/system/info`;
  };

  it('returns the server stamp and the daemon stamp', async () => {
    const url = await start({
      serverBuild: { id: 'abc1234', builtAt: '2026-10-04T08:09:10.000Z', kind: 'build' },
      getDaemonBuild: async () => ({ id: 'abc1234', builtAt: '2026-10-04T08:09:10.000Z' }),
    });
    const body = await (await fetch(url)).json();
    expect(body.serverBuild).toEqual({ id: 'abc1234', builtAt: '2026-10-04T08:09:10.000Z', kind: 'build' });
    expect(body.daemonBuild).toEqual({ id: 'abc1234', builtAt: '2026-10-04T08:09:10.000Z' });
  });

  it('reports an unreadable daemon as null instead of failing the info call', async () => {
    const url = await start({
      serverBuild: { id: 'source-abc1234', builtAt: '2026-10-04T09:00:00.000Z', kind: 'source' },
      getDaemonBuild: async () => { throw new Error('daemon unavailable'); },
    });
    const response = await fetch(url);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.daemonBuild).toBeNull();
    expect(body.serverBuild.kind).toBe('source');
  });
});
