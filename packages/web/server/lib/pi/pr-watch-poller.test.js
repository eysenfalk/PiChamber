import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPrWatchPoller } from './pr-watch-poller.js';

const target = (sessionId, number) => ({ sessionId, directory: `/wt/${sessionId}`, repository: 'o/r', number });

const setup = ({ targets = [], readPullWatch = vi.fn(async () => ({ state: 'open' })) } = {}) => {
  const request = vi.fn(async (_command, payload) => (payload.reads ? { targets: [] } : { targets }));
  const poller = createPrWatchPoller({ supervisor: { request }, readPullWatch, intervalMs: 60_000 });
  return { request, readPullWatch, poller };
};

describe('pull request watch poller', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('asks the daemon every minute and hands back the reads', async () => {
    const { request, readPullWatch, poller } = setup({ targets: [target('w1', 7), target('w2', 8)] });
    poller.start();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(readPullWatch).toHaveBeenCalledWith({ directory: '/wt/w1', repository: 'o/r', number: 7 });
    expect(request).toHaveBeenLastCalledWith('orchestration.prWatch', {
      reads: [
        { sessionId: 'w1', repository: 'o/r', number: 7, read: { state: 'open' } },
        { sessionId: 'w2', repository: 'o/r', number: 8, read: { state: 'open' } },
      ],
    });
    poller.stop();
  });

  it('reads nothing and sends nothing when no worker has a pull request', async () => {
    const { request, readPullWatch, poller } = setup();
    poller.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(request).toHaveBeenCalledTimes(1);
    expect(readPullWatch).not.toHaveBeenCalled();
    poller.stop();
  });

  it('skips a failed or empty read and logs the code only, never the message', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const readPullWatch = vi.fn(async ({ number }) => {
      if (number === 7) throw Object.assign(new Error('token ghp_secret leaked in body'), { code: 'GITHUB_FAILED' });
      return number === 8 ? null : { state: 'open' };
    });
    const { request, poller } = setup({ targets: [target('w1', 7), target('w2', 8), target('w3', 9)], readPullWatch });
    poller.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(request).toHaveBeenLastCalledWith('orchestration.prWatch', {
      reads: [{ sessionId: 'w3', repository: 'o/r', number: 9, read: { state: 'open' } }],
    });
    expect(JSON.stringify(warn.mock.calls)).toContain('GITHUB_FAILED');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('ghp_secret');
    poller.stop();
  });

  it('survives an unavailable daemon and stops ticking after stop', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const request = vi.fn(async () => { throw Object.assign(new Error('boom'), { code: 'DAEMON_UNAVAILABLE' }); });
    const poller = createPrWatchPoller({ supervisor: { request }, readPullWatch: vi.fn(), intervalMs: 60_000 });
    poller.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(request).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(warn.mock.calls)).toContain('DAEMON_UNAVAILABLE');
    poller.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
