import { describe, expect, it, vi } from 'vitest';

import { createPrWatch } from '../pi/session-daemon/orchestration/pr-watch.js';
import { createChecksService } from './checks.js';
import { createGitHubClient } from './client.js';
import { createPullWatchReader } from './pull-watch.js';

const pullBody = (overrides = {}) => ({
  state: 'open', merged_at: null, head: { sha: 'abc1234def' }, html_url: 'https://github.com/o/r/pull/7', comments: 2, review_comments: 3, ...overrides,
});
const summary = { state: 'success', total: 3, pending: 0, success: 3, failure: 0 };

const setup = ({ body = pullBody(), checks = { summary } } = {}) => {
  const request = vi.fn(async () => ({ body }));
  const getChecks = vi.fn(async () => checks);
  const scopeResolver = {
    resolveScope: vi.fn(async () => ({})),
    matchAllowedRepo: vi.fn((_scope, ref) => (ref === 'github.com/o/r' ? { host: 'github.com', owner: 'o', repo: 'r' } : null)),
  };
  const credential = { withPinnedCredential: vi.fn(async (_host, task) => task({ host: 'github.com', token: 'secret' })) };
  const read = createPullWatchReader({ scopeResolver, credential, client: { request, isRateLimited: () => false }, checks: { getChecks } });
  return { read, request, getChecks };
};
const target = { directory: '/wt/a', repository: 'o/r', number: 7 };

describe('pull request watch reader', () => {
  it('returns state, head, summed comments and the rolled up checks', async () => {
    const { read, request, getChecks } = setup();
    expect(await read(target)).toEqual({
      state: 'open',
      headSha: 'abc1234def',
      url: 'https://github.com/o/r/pull/7',
      comments: 5,
      checks: { state: 'success', total: 3, pending: 0 },
      incomplete: false,
    });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ method: 'GET', path: '/repos/o/r/pulls/7' }));
    expect(getChecks).toHaveBeenCalledWith(expect.anything(), { host: 'github.com', owner: 'o', repo: 'r' }, 'abc1234def', { details: false });
  });

  it('marks a stale or partial checks read incomplete', async () => {
    expect((await setup({ checks: { summary, stale: true } }).read(target)).incomplete).toBe(true);
    expect((await setup({ checks: { summary, sectionErrors: { runs: {} } } }).read(target)).incomplete).toBe(true);
  });

  it('reads no checks for a merged or closed pull request', async () => {
    const merged = setup({ body: pullBody({ state: 'closed', merged_at: '2026-01-01T00:00:00Z' }) });
    expect(await merged.read(target)).toMatchObject({ state: 'merged', checks: null });
    expect(merged.getChecks).not.toHaveBeenCalled();
    expect(await setup({ body: pullBody({ state: 'closed' }) }).read(target)).toMatchObject({ state: 'closed' });
  });

  it('reads nothing for a repository outside the allow list', async () => {
    const { read, request } = setup();
    expect(await read({ ...target, repository: 'other/repo' })).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });
});

// Real checks service and GitHub client over a fake fetch.
const json = (body, init = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
const realSetup = ({ statuses = [], runs = [], clock = { now: 1_000_000 } } = {}) => {
  const urls = [];
  const fetchImpl = vi.fn(async (url) => {
    urls.push(url);
    if (url.includes('/pulls/7')) return json(pullBody({ comments: 0, review_comments: 0 }));
    if (url.includes('/check-runs')) return json({ check_runs: runs });
    if (url.includes('/statuses')) return json(statuses);
    throw new Error(`unexpected ${url}`);
  });
  const client = createGitHubClient({ fetchImpl, now: () => clock.now });
  const scopeResolver = {
    resolveScope: async () => ({}),
    matchAllowedRepo: () => ({ host: 'github.com', owner: 'o', repo: 'r' }),
  };
  const credential = { withPinnedCredential: async (_host, task) => task({ host: 'github.com', token: 'secret', fingerprint: 'fp' }) };
  const checks = createChecksService({ client, now: () => clock.now });
  return { read: createPullWatchReader({ scopeResolver, credential, client, checks }), fetchImpl, urls, clock, client };
};

describe('pull request watch reader over the real checks service', () => {
  it('judges the latest status per context: old pending and failure entries do not count', async () => {
    const { read } = realSetup({
      statuses: [
        { id: 3, context: 'ci/build', state: 'success', created_at: '2026-01-01T00:03:00Z' },
        { id: 2, context: 'ci/build', state: 'failure', created_at: '2026-01-01T00:02:00Z' },
        { id: 1, context: 'ci/build', state: 'pending', created_at: '2026-01-01T00:01:00Z' },
        { id: 5, context: 'ci/lint', state: 'success', created_at: '2026-01-01T00:02:30Z' },
        { id: 4, context: 'ci/lint', state: 'pending', created_at: '2026-01-01T00:00:30Z' },
      ],
    });
    const result = await read(target);
    expect(result.checks).toMatchObject({ state: 'success', total: 2, pending: 0 });
    const events = [];
    const watch = createPrWatch({
      registry: { read: async () => ({ workers: { w1: { cwd: '/wt/a', state: 'active', pullRequest: { number: 7, repository: 'o/r' } } } }) },
      emit: (...args) => events.push(args),
      readSettings: async () => ({}),
    });
    await watch.apply([{ sessionId: 'w1', repository: 'o/r', number: 7, read: result }]);
    await watch.apply([{ sessionId: 'w1', repository: 'o/r', number: 7, read: result }]);
    expect(events.map(([, kind]) => kind)).toEqual(['ci_passed']);
  });

  it('still reports a context whose latest status is a failure', async () => {
    const { read } = realSetup({
      statuses: [
        { id: 2, context: 'ci/build', state: 'failure', created_at: '2026-01-01T00:02:00Z' },
        { id: 1, context: 'ci/build', state: 'success', created_at: '2026-01-01T00:01:00Z' },
      ],
    });
    expect((await read(target)).checks).toMatchObject({ state: 'failure', total: 1, pending: 0 });
  });
});

describe('pull request watch reader inside a rate limit window', () => {
  it('reads nothing before the retry time and reads again after it', async () => {
    const clock = { now: 1_000_000 };
    const setupLimited = realSetup({ statuses: [{ id: 1, context: 'ci', state: 'success', created_at: '2026-01-01T00:00:00Z' }], clock });
    const { read, fetchImpl } = setupLimited;
    // The first request meets GitHub's rate limit answer.
    fetchImpl.mockImplementationOnce(async () => new Response('{"message":"API rate limit exceeded"}', { status: 429, headers: { 'retry-after': '180', 'content-type': 'application/json' } }));
    await expect(read(target)).rejects.toMatchObject({ kind: 'rate-limited' });
    const requests = fetchImpl.mock.calls.length;

    clock.now += 60_000;
    expect(await read(target)).toBeNull();
    clock.now += 119_000;
    expect(await read(target)).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(requests);

    clock.now += 2_000;
    expect(await read(target)).toMatchObject({ state: 'open', checks: { state: 'success' } });
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(requests);
  });
});
