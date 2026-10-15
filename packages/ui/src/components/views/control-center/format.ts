import type {
  PiOrchestrationLiveState,
  PiOrchestrationPullRequestStatus,
  PiOrchestrationReport,
  PiOrchestrationWorkerLifecycle,
} from '@/lib/pi/protocol';

/**
 * Pure display helpers for the control center. Ages are measured against the
 * overview's own `at`, so they follow the daemon clock and need no ticking
 * timer between polls.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const GIB = 1024 ** 3;

export const formatAge = (at: number | null, now: number): string | null => {
  if (at === null) return null;
  const elapsed = Math.max(0, now - at);
  if (elapsed < MINUTE) return 'just now';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} h ago`;
  const days = Math.floor(elapsed / DAY);
  return days === 1 ? '1 day ago' : `${days} days ago`;
};

export const formatClock = (at: number): string => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export const formatGiB = (bytes: number): string => `${(bytes / GIB).toFixed(1)} GiB`;

export const LIFECYCLE_LABEL: Record<PiOrchestrationWorkerLifecycle, string> = {
  starting: 'starting',
  active: 'active',
  done: 'done',
  stopped: 'stopped',
};

export const LIVE_LABEL: Record<PiOrchestrationLiveState, string> = {
  dormant: 'dormant',
  idle: 'idle',
  busy: 'working',
  retry: 'retrying',
  waiting_input: 'waiting for input',
};

export const REPORT_LABEL: Record<PiOrchestrationReport['kind'], string> = {
  progress: 'Progress',
  question: 'Question',
  blocked: 'Blocked',
  ready: 'Ready',
  done: 'Done',
};

export type Tone = 'neutral' | 'success' | 'warning' | 'error' | 'info';

/** CI as one short label and tone; null when the pull request was not read yet or has no checks. */
export const describeChecks = (status: PiOrchestrationPullRequestStatus | null): { label: string; tone: Tone } | null => {
  const checks = status?.checks;
  if (!checks || checks.total === 0) return null;
  switch (checks.state) {
    case 'success':
      return { label: 'CI passed', tone: 'success' };
    case 'failure':
      return { label: 'CI failed', tone: 'error' };
    case 'pending':
      return { label: checks.pending === 1 ? 'CI: 1 check running' : `CI: ${checks.pending} checks running`, tone: 'info' };
    default:
      return { label: 'CI unknown', tone: 'neutral' };
  }
};

export const TONE_TEXT_CLASS: Record<Tone, string> = {
  neutral: 'text-muted-foreground',
  success: 'text-[var(--status-success)]',
  warning: 'text-[var(--status-warning)]',
  error: 'text-[var(--status-error)]',
  info: 'text-[var(--status-info)]',
};
