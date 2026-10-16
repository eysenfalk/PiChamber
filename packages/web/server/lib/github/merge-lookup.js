/**
 * Uncached merge reads for the orchestrator's worker cleanup (#118): the
 * pull request of a head branch and one pull request by number. The session
 * daemon runs them right before it removes a worker, so a cached answer is no
 * proof. github.com only, like the pull request watch.
 */

import { createGitHubClient } from './client.js';
import { createCredentialStore } from './credential.js';
import { createGhCli } from './gh-cli.js';
import { createPullsService, mapPullSummary } from './pulls.js';
import { isValidIssueNumber } from './repo-scope.js';

const HOST = 'github.com';

const toRepo = (repository) => {
  const [owner, repo] = String(repository).split('/');
  return { host: HOST, owner, repo };
};

const pick = (pr) => (pr ? { number: pr.number, state: pr.state, mergedAt: pr.mergedAt, headSha: pr.headSha, url: pr.url } : null);

export const createMergeLookup = ({ ghCli = createGhCli(), client = createGitHubClient() } = {}) => {
  const credential = createCredentialStore({ ghCli });
  const pulls = createPullsService({ client });
  return {
    pullForBranch: ({ repository, branch }) => credential.withPinnedCredential(HOST, async (cred) => (
      pick((await pulls.findPullForBranch(cred, toRepo(repository), { branch })).pr)
    )),
    pullByNumber: ({ repository, number }) => credential.withPinnedCredential(HOST, async (cred) => {
      if (!isValidIssueNumber(number)) return null;
      const repo = toRepo(repository);
      const response = await client.request({
        credential: cred,
        host: HOST,
        method: 'GET',
        path: `/repos/${repo.owner}/${repo.repo}/pulls/${number}`,
        operation: 'pull request merge state',
      });
      return response.body ? pick(mapPullSummary(response.body)) : null;
    }),
  };
};
