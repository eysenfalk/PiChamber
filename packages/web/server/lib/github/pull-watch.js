/**
 * One normalized read of a pull request for the orchestrator's pull request
 * watch (#119): state, head commit, comment count and the rolled up checks.
 * Same allow list and pinned credential as the routes; nothing is cached
 * beyond what the checks service already does, and nothing is persisted.
 */

import { isValidIssueNumber } from './repo-scope.js';

// `worker.pullRequest` carries `owner/repo` without a host.
const WATCH_HOST = 'github.com';

const mapState = (body) => {
  if (body?.merged_at || body?.merged === true) return 'merged';
  return body?.state === 'closed' ? 'closed' : 'open';
};

const count = (value) => (Number.isInteger(value) && value >= 0 ? value : 0);

export const createPullWatchReader = ({ scopeResolver, credential, client, checks }) => async ({ directory, repository, number }) => {
  if (typeof directory !== 'string' || !directory || !isValidIssueNumber(number)) return null;
  const scope = await scopeResolver.resolveScope(directory);
  const entry = scopeResolver.matchAllowedRepo(scope, `${WATCH_HOST}/${repository}`);
  if (!entry) return null;
  const repo = { host: entry.host, owner: entry.owner, repo: entry.repo };
  return credential.withPinnedCredential(repo.host, async (cred) => {
    const response = await client.request({
      credential: cred,
      host: repo.host,
      method: 'GET',
      path: `/repos/${repo.owner}/${repo.repo}/pulls/${number}`,
      operation: 'pull request watch',
    });
    const body = response.body;
    const headSha = body?.head?.sha;
    if (typeof headSha !== 'string' || !headSha) return null;
    const state = mapState(body);
    const result = {
      state,
      headSha,
      url: body.html_url || '',
      comments: count(body.comments) + count(body.review_comments),
      checks: null,
      incomplete: false,
    };
    if (state !== 'open') return result;
    const { summary, stale, sectionErrors } = await checks.getChecks(cred, repo, headSha, { details: false });
    return {
      ...result,
      checks: { state: summary.state, total: summary.total, pending: summary.pending },
      // A stale or partial checks read is not an authoritative result.
      incomplete: stale === true || Boolean(sectionErrors),
    };
  });
};
