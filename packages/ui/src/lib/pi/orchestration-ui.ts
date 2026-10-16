/**
 * PiChamber orchestration result messages (parsing side).
 *
 * When a worker session settles, the session daemon delivers a displayed custom
 * message `pichamber.orchestration.result` to its parent. `details` carries
 * the worker identity; `text` is the header line followed by the worker's last
 * reply. Anything that fails validation returns `undefined`, and the caller
 * falls back to the generic extension card.
 */

const ORCHESTRATION_RESULT_MESSAGE_TYPE = 'pichamber.orchestration.result';

export type OrchestrationOutcome = 'completed' | 'interrupted' | 'error';

export interface OrchestrationResult {
  sessionId: string;
  title: string;
  cwd: string;
  outcome: OrchestrationOutcome;
  role?: string;
  /** First non-empty line of the reply, for the collapsed row. */
  summary: string;
  /** The reply as Markdown source, without the header line. */
  body: string;
}

const MAX_SUMMARY_CHARS = 200;
const MAX_FIELD_CHARS = 512;

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const isOutcome = (value: unknown): value is OrchestrationOutcome => (
  value === 'completed' || value === 'interrupted' || value === 'error'
);

const isField = (value: unknown): value is string => (
  typeof value === 'string' && value.length > 0 && value.length <= MAX_FIELD_CHARS
);

const firstLine = (value: string): string => {
  for (const line of value.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed.length > MAX_SUMMARY_CHARS ? `${trimmed.slice(0, MAX_SUMMARY_CHARS - 1)}…` : trimmed;
  }
  return '';
};

/** Parse a `pichamber.orchestration.result` custom message; `undefined` when the payload is not valid. */
export const parseOrchestrationResult = (input: {
  customType?: string;
  text?: string;
  details?: unknown;
}): OrchestrationResult | undefined => {
  if (input.customType !== ORCHESTRATION_RESULT_MESSAGE_TYPE) return undefined;
  const details = input.details;
  if (!isRecord(details)) return undefined;
  if (!isField(details.sessionId) || !isField(details.cwd) || !isOutcome(details.outcome)) return undefined;
  if (details.title !== undefined && typeof details.title !== 'string') return undefined;
  if (details.role !== undefined && !isField(details.role)) return undefined;

  const text = (input.text ?? '').replace(/\r\n/g, '\n');
  const headerEnd = text.indexOf('\n');
  const body = (headerEnd === -1 ? '' : text.slice(headerEnd + 1)).trim();
  const title = typeof details.title === 'string' && details.title.trim().length > 0
    ? details.title.trim().slice(0, MAX_FIELD_CHARS)
    : details.sessionId;

  return {
    sessionId: details.sessionId,
    title,
    cwd: details.cwd,
    outcome: details.outcome,
    ...(details.role ? { role: details.role } : {}),
    summary: firstLine(body),
    body,
  };
};
