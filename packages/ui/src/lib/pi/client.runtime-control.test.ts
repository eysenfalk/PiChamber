import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import { PiRequestError, PiService } from '@/lib/pi/client';

const originalFetch = globalThis.fetch;

type FetchCall = { url: string; method: string | undefined };
const calls: FetchCall[] = [];

const install = (responder: (call: FetchCall) => Response) => {
  calls.length = 0;
  globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
    const call = { url, method: init?.method };
    calls.push(call);
    return responder(call);
  }) as unknown as typeof fetch;
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

const failureOf = async (promise: Promise<unknown>): Promise<PiRequestError> => {
  const outcome = await promise.then(() => null, (error: unknown) => error);
  expect(outcome).toBeInstanceOf(PiRequestError);
  return outcome as PiRequestError;
};

describe('PiService runtime control', () => {
  beforeEach(() => {
    calls.length = 0;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('reloadRuntime posts to the reload route and returns the three counts', async () => {
    install(() => json({ reloaded: 2, deferred: 1, failed: 0 }));
    const result = await new PiService().reloadRuntime();
    expect(result).toEqual({ reloaded: 2, deferred: 1, failed: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/api/pi/runtime/reload');
    expect(calls[0].method).toBe('POST');
  });

  test('reloadRuntime rejects a malformed reply as a protocol mismatch', async () => {
    install(() => json({ reloaded: 'two' }));
    const failure = await failureOf(new PiService().reloadRuntime());
    expect(failure.code).toBe('DAEMON_PROTOCOL_MISMATCH');
  });

  test('restartRuntime posts once to the restart route and returns the scope', async () => {
    install(() => json({ accepted: true, scope: 'daemon' }, 202));
    const result = await new PiService().restartRuntime();
    expect(result).toEqual({ accepted: true, scope: 'daemon' });
    expect(calls[0].url).toContain('/api/pi/runtime/restart');
    expect(calls[0].method).toBe('POST');
  });

  test('restartRuntime is not retried after a transient failure', async () => {
    install(() => json({ error: { code: 'DAEMON_UNAVAILABLE' } }, 503));
    await failureOf(new PiService().restartRuntime());
    expect(calls).toHaveLength(1);
  });

  test('restartRuntime surfaces the server failure code', async () => {
    install(() => json({ error: { code: 'RESTART_FAILED', message: 'The restart failed (DAEMON_STOP_TIMEOUT).' } }, 500));
    const failure = await failureOf(new PiService().restartRuntime());
    expect(failure.code).toBe('RESTART_FAILED');
    expect(failure.status).toBe(500);
    expect(failure.message).toBe('The restart failed (DAEMON_STOP_TIMEOUT).');
  });

  test('restartRuntime rejects an unknown scope', async () => {
    install(() => json({ accepted: true, scope: 'cluster' }, 202));
    const failure = await failureOf(new PiService().restartRuntime());
    expect(failure.code).toBe('DAEMON_PROTOCOL_MISMATCH');
  });
});
