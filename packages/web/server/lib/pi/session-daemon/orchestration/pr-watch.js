// Pull request watch (#119): turns what GitHub says about a worker's pull
// request into wake events. The web server reads GitHub (the GitHub module
// needs its HTTP context) and hands the reads over IPC; the diff and its
// memory-only state stay here, next to the wakes it feeds.

const isFinalChecks = (checks) => Boolean(checks)
  && checks.total > 0
  && checks.pending === 0
  && (checks.state === 'success' || checks.state === 'failure');

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * Compares the last state of one pull request with a new read.
 * `previous` is undefined on the first read since the daemon started: a final
 * CI result or a merge is reported once, comments only seed the count.
 * A missing or incomplete (stale, partial) read changes nothing.
 */
export const diffPullRequest = (previous, read) => {
  if (!read || read.incomplete) return { state: previous, events: [] };
  const label = `PR #${read.number}`;
  if (read.state !== 'open') {
    const kind = read.state === 'merged' ? 'pr_merged' : 'pr_closed';
    const events = previous?.status === read.state ? [] : [{ kind, reason: `${label} ${read.state}: ${read.url}` }];
    return { state: { ...previous, status: read.state, url: read.url }, events };
  }
  const events = [];
  const sameHead = previous?.head === read.headSha;
  let ciReported = sameHead && previous.ciReported;
  if (!ciReported && isFinalChecks(read.checks)) {
    const passed = read.checks.state === 'success';
    events.push({
      kind: passed ? 'ci_passed' : 'ci_failed',
      reason: `${label} checks ${passed ? 'passed' : 'failed'} on ${read.headSha.slice(0, 7)} (${plural(read.checks.total, 'check')}): ${read.url}`,
    });
    ciReported = true;
  }
  if (previous && read.comments > previous.comments) {
    events.push({ kind: 'review_activity', reason: `${plural(read.comments - previous.comments, 'new comment')} on ${label}: ${read.url}` });
  }
  const checks = read.checks ? { state: read.checks.state, total: read.checks.total, pending: read.checks.pending } : null;
  return { state: { status: 'open', head: read.headSha, ciReported, comments: read.comments, url: read.url, checks }, events };
};

const samePullRequest = (worker, { repository, number }) => worker?.pullRequest?.number === number
  && worker.pullRequest.repository === repository;

export const createPrWatch = ({ registry, emit, readSettings }) => {
  // sessionId -> last state; a changed pull request starts over.
  const states = new Map();

  // A merged or closed pull request is finished only for the one the worker
  // still reports; a new report starts the watch over.
  const isFinished = (sessionId, { repository, number }) => {
    const known = states.get(sessionId);
    return known?.key === `${repository}#${number}` && known.state.status !== 'open';
  };

  const targets = async () => {
    const settings = await readSettings().catch(() => undefined);
    if (settings?.github?.enabled === false) return [];
    const { workers } = await registry.read();
    return Object.entries(workers)
      .filter(([sessionId, worker]) => worker.pullRequest && !worker.stopping && worker.state !== 'stopped'
        && !isFinished(sessionId, worker.pullRequest))
      .map(([sessionId, worker]) => ({ sessionId, directory: worker.cwd, ...worker.pullRequest }));
  };

  const apply = async (reads) => {
    const { workers } = await registry.read();
    for (const { sessionId, repository, number, read } of reads) {
      if (!samePullRequest(workers[sessionId], { repository, number })) continue;
      const key = `${repository}#${number}`;
      const known = states.get(sessionId);
      const { state, events } = diffPullRequest(known?.key === key ? known.state : undefined, read && { ...read, number });
      if (state) states.set(sessionId, { key, state });
      for (const event of events) emit(sessionId, event.kind, event.reason);
    }
  };

  // What the last read said about the pull request the worker reports now,
  // or null before the first read since the daemon started.
  const statusOf = (sessionId, pullRequest) => {
    const known = states.get(sessionId);
    if (!pullRequest || known?.key !== `${pullRequest.repository}#${pullRequest.number}`) return null;
    const { status, url = null, head = null, checks = null } = known.state;
    return { status, url, head, checks };
  };

  return { targets, apply, statusOf };
};
