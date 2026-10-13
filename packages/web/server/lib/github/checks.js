/** Check runs + commit statuses rollup, job steps, annotations, re-runs. See DOCUMENTATION.md. */

import { createTtlCache, readWithStaleFallback, repoCachePrefix, repoInvalidatePredicate } from './cache.js';
import { inputError, toSectionError } from './errors.js';

export const CHECKS_TTL_MS = 15_000;
export const SHORT_TTL_MS = 15_000;

const normalizeConclusion = (status, conclusion) => {
  if (status === 'queued' || status === 'in_progress' || status === 'waiting' || status === 'requested') {
    return 'pending';
  }
  if (!conclusion) return status === 'completed' ? 'unknown' : 'pending';
  if (conclusion === 'success' || conclusion === 'neutral' || conclusion === 'skipped') return 'success';
  if (conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'action_required' || conclusion === 'cancelled') {
    return 'failure';
  }
  return 'pending';
};

// `/commits/{sha}/statuses` lists every status ever set on the commit, so an
// old pending or failure entry stays beside the later success of its context.
// Only the latest entry per context is the current state.
const latestPerContext = (statuses) => {
  const latest = new Map();
  for (const status of statuses) {
    const key = status?.context || '';
    const known = latest.get(key);
    if (!known || String(status.created_at || '') > String(known.created_at || '')) latest.set(key, status);
  }
  return [...latest.values()];
};

export const rollupCheckStates = (runs) => {
  let success = 0;
  let failure = 0;
  let pending = 0;
  for (const run of runs) {
    const state = normalizeConclusion(run.status, run.conclusion);
    if (state === 'success') success += 1;
    else if (state === 'failure') failure += 1;
    else pending += 1;
  }
  return {
    state: runs.length === 0 ? 'unknown' : (failure > 0 ? 'failure' : (pending > 0 ? 'pending' : 'success')),
    total: runs.length,
    success,
    failure,
    pending,
  };
};

const workflowRunIdFromUrl = (url) => {
  const match = typeof url === 'string' ? url.match(/\/actions\/runs\/(\d+)/) : null;
  return match ? Number(match[1]) : null;
};

const mapJob = (job) => ({
  id: job.id,
  name: job.name || '',
  status: job.status || null,
  conclusion: job.conclusion || null,
  startedAt: job.started_at || null,
  completedAt: job.completed_at || null,
  detailsUrl: job.html_url || null,
  steps: (job.steps || []).map((step) => ({
    name: step.name || '',
    status: step.status || null,
    conclusion: step.conclusion || null,
    number: step.number ?? null,
    startedAt: step.started_at || null,
    completedAt: step.completed_at || null,
  })),
});

const mapCheckRun = (run) => ({
  id: run.id,
  name: run.name || '',
  status: run.status || null,
  conclusion: run.conclusion || null,
  state: normalizeConclusion(run.status, run.conclusion),
  startedAt: run.started_at || null,
  completedAt: run.completed_at || null,
  detailsUrl: run.details_url || run.html_url || null,
  app: run.app ? { name: run.app.name || null, slug: run.app.slug || null } : null,
  // Actions check runs are jobs: the check-run id is the job id, and the
  // workflow run id (needed for re-runs) only appears in the details URL.
  runId: workflowRunIdFromUrl(run.details_url || run.html_url),
});

export const createChecksService = ({ client, now = Date.now } = {}) => {
  if (!client || typeof client.request !== 'function') {
    throw new Error('createChecksService requires client');
  }
  const checksCache = createTtlCache({ ttlMs: CHECKS_TTL_MS, maxEntries: 300, now });
  const stepsCache = createTtlCache({ ttlMs: SHORT_TTL_MS, maxEntries: 300, now });
  const annotationsCache = createTtlCache({ ttlMs: SHORT_TTL_MS, maxEntries: 300, now });

  const getChecks = async (credential, repo, ref, { details = false } = {}) => {
    if (typeof ref !== 'string' || !ref.trim() || ref.length > 200) {
      throw inputError('A commit SHA or ref is required.');
    }
    const cleanRef = ref.trim();
    const key = `${repoCachePrefix(credential, repo)}:checks:${cleanRef}:${details ? 'full' : 'summary'}`;
    const load = async () => {
      const [runsSettled, statusesSettled] = await Promise.all([
        client.request({
          credential, host: repo.host, method: 'GET',
          path: `/repos/${repo.owner}/${repo.repo}/commits/${encodeURIComponent(cleanRef)}/check-runs`,
          query: { per_page: 100 },
          operation: 'check runs',
        }).then((response) => ({ ok: true, response }), (error) => ({ ok: false, error })),
        client.request({
          credential, host: repo.host, method: 'GET',
          path: `/repos/${repo.owner}/${repo.repo}/commits/${encodeURIComponent(cleanRef)}/statuses`,
          query: { per_page: 100 },
          operation: 'commit statuses',
        }).then((response) => ({ ok: true, response }), (error) => ({ ok: false, error })),
      ]);
      // A failed source is never an authoritative empty result: surface it
      // in `sectionErrors` so callers render a failure, not "no checks".
      // When both sources fail the whole read fails so stale fallback applies.
      if (!runsSettled.ok && !statusesSettled.ok) {
        throw runsSettled.error;
      }
      const sectionErrors = {};
      if (!runsSettled.ok) sectionErrors.runs = toSectionError(runsSettled.error);
      if (!statusesSettled.ok) sectionErrors.statuses = toSectionError(statusesSettled.error);
      const runsResponse = runsSettled.ok ? runsSettled.response : { body: { check_runs: [] } };
      const statusesResponse = statusesSettled.ok ? statusesSettled.response : { body: [] };
      const runs = (runsResponse.body?.check_runs || []).map(mapCheckRun);
      const statuses = latestPerContext(Array.isArray(statusesResponse.body) ? statusesResponse.body : []).map((status) => ({
        id: status.id ?? null,
        context: status.context || '',
        state: status.state || null,
        description: status.description || null,
        targetUrl: status.target_url || null,
        creator: status.creator ? { login: status.creator.login || null } : null,
        createdAt: status.created_at || null,
      }));
      const combined = [
        ...runs.map((run) => ({ status: run.status === 'completed' ? 'completed' : 'in_progress', conclusion: run.conclusion })),
        ...statuses.map((status) => ({
          status: status.state === 'pending' ? 'in_progress' : 'completed',
          conclusion: status.state === 'success' ? 'success' : (status.state === 'failure' || status.state === 'error' ? 'failure' : null),
        })),
      ];
      const summary = rollupCheckStates(combined);
      const earliestStarted = runs
        .map((run) => run.startedAt)
        .filter(Boolean)
        .sort()[0] || null;
      return {
        summary: { ...summary, startedAt: earliestStarted },
        runs: details ? runs : runs.map((run) => ({
          id: run.id, name: run.name, state: run.state, conclusion: run.conclusion,
          detailsUrl: run.detailsUrl, app: run.app, runId: run.runId,
        })),
        statuses: details ? statuses : statuses.map((status) => ({ context: status.context, state: status.state })),
        ...(Object.keys(sectionErrors).length > 0 ? { sectionErrors } : {}),
      };
    };
    const { value, fetchedAt, stale } = await readWithStaleFallback(checksCache, key, load);
    return { repo: { ...repo }, ref: cleanRef, ...value, fetchedAt, ...(stale ? { stale: true } : {}) };
  };

  // Cached ~15 s so concurrent drill-down mounts coalesce; a re-run
  // invalidates this repo's entries so fresh steps are one re-read away.
  const getJobSteps = async (credential, repo, { runId = null, jobId = null } = {}) => {
    const hasJob = jobId !== null && jobId !== undefined && jobId !== '';
    const id = Number(hasJob ? jobId : runId);
    if (!Number.isInteger(id) || id < 1) throw inputError('A workflow job or run id is required.');
    // A single job (check-run id) is one direct read; a run lists its jobs.
    const key = `${repoCachePrefix(credential, repo)}:jobs:${hasJob ? 'job' : 'run'}:${id}`;
    const load = async () => {
      if (hasJob) {
        const response = await client.request({
          credential, host: repo.host, method: 'GET',
          path: `/repos/${repo.owner}/${repo.repo}/actions/jobs/${id}`,
          operation: 'workflow job',
        });
        return { runId: response.body?.run_id ?? null, jobs: [mapJob(response.body || {})] };
      }
      const response = await client.request({
        credential, host: repo.host, method: 'GET',
        path: `/repos/${repo.owner}/${repo.repo}/actions/runs/${id}/jobs`,
        query: { per_page: 100 },
        operation: 'workflow jobs',
      });
      return { runId: id, jobs: (response.body?.jobs || []).map(mapJob) };
    };
    const { value, fetchedAt, stale } = await readWithStaleFallback(stepsCache, key, load);
    return { repo: { ...repo }, runId: value.runId, jobs: value.jobs, fetchedAt, ...(stale ? { stale: true } : {}) };
  };

  const getAnnotations = async (credential, repo, { checkRunId }) => {
    const id = Number(checkRunId);
    if (!Number.isInteger(id) || id < 1) throw inputError('A check run id is required.');
    const key = `${repoCachePrefix(credential, repo)}:annotations:${id}`;
    const load = async () => {
      const response = await client.request({
        credential, host: repo.host, method: 'GET',
        path: `/repos/${repo.owner}/${repo.repo}/check-runs/${id}/annotations`,
        query: { per_page: 100 },
        operation: 'check annotations',
      });
      return {
        annotations: (Array.isArray(response.body) ? response.body : []).map((annotation) => ({
          path: annotation.path || null,
          startLine: annotation.start_line ?? null,
          endLine: annotation.end_line ?? null,
          level: annotation.annotation_level || null,
          message: annotation.message || '',
          title: annotation.title || null,
        })),
      };
    };
    const { value, fetchedAt, stale } = await readWithStaleFallback(annotationsCache, key, load);
    return { repo: { ...repo }, checkRunId: id, ...value, fetchedAt, ...(stale ? { stale: true } : {}) };
  };

  const rerunFailed = async (credential, repo, { runId }) => {
    const run = Number(runId);
    if (!Number.isInteger(run) || run < 1) throw inputError('A workflow run id is required.');
    await client.request({
      credential, host: repo.host, method: 'POST',
      path: `/repos/${repo.owner}/${repo.repo}/actions/runs/${run}/rerun-failed-jobs`,
      operation: 're-run failed jobs',
    });
    invalidate(credential, repo);
    return { ok: true, runId: run, fetchedAt: now() };
  };

  const invalidate = (credential = null, repo = null) => {
    const fingerprint = credential?.fingerprint || '';
    const predicate = repoInvalidatePredicate({ fingerprint, repo });
    checksCache.invalidate(predicate);
    stepsCache.invalidate(predicate);
    annotationsCache.invalidate(predicate);
  };

  return { getChecks, getJobSteps, getAnnotations, rerunFailed, invalidate, rollupCheckStates };
};
