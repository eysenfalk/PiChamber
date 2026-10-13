import { describe, expect, it, vi } from 'vitest';

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
  const read = createPullWatchReader({ scopeResolver, credential, client: { request }, checks: { getChecks } });
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
