/**
 * pi-subagents supervisor messages (parsing side).
 *
 * pi-subagents surfaces a child's request for the supervisor as a displayed
 * custom message (`subagent_supervisor_request`, payload in `details`) and
 * records the supervisor's answer as a custom entry (`subagent_supervisor_reply`,
 * payload in `data`). Validation mirrors `src/intercom/supervisor-ui.js` in
 * pi-subagents so both surfaces accept the same payloads; anything that fails
 * validation returns `undefined` and the caller falls back to the generic
 * extension card. Text is display-only: React escapes it, and control
 * characters are replaced the way pi-subagents' terminal rendering does.
 */

export const SUPERVISOR_REQUEST_MESSAGE_TYPE = 'subagent_supervisor_request';
export const SUPERVISOR_REPLY_ENTRY_TYPE = 'subagent_supervisor_reply';

const MAX_FIELD_CHARS = 512;
const MAX_BODY_CHARS = 8_000;
const MAX_INTERVIEW_CHARS = 4_000;
const MAX_SUMMARY_CHARS = 200;
const TRUNCATION_MARKER = '[truncated]';

type SupervisorReason = 'need_decision' | 'interview_request' | 'progress_update';

export interface SupervisorDetail {
  label: string;
  value: string;
}

export interface SupervisorRequest {
  agent: string;
  /** Short label for the request kind: Decision, Interview or Progress. */
  reasonLabel: string;
  /** The question as Markdown source. */
  question: string;
  /** Run, child, request id and reply hint: shown only behind a disclosure. */
  details: SupervisorDetail[];
}

export interface SupervisorReply {
  agent: string;
  /** First non-empty line of the reply, for the collapsed row. */
  summary: string;
  /** The full reply as Markdown source. */
  message: string;
  details: SupervisorDetail[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const isSupervisorReason = (value: unknown): value is SupervisorReason => (
  value === 'need_decision' || value === 'interview_request' || value === 'progress_update'
);

const isOptionalString = (value: unknown): boolean => value === undefined || typeof value === 'string';

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const isUnsafeCodePoint = (codePoint: number): boolean => (
  (codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a)
  || (codePoint >= 0x7f && codePoint <= 0x9f)
);

const safeText = (value: string): string => {
  let safe = '';
  for (const character of value.replace(/\r\n/g, '\n')) {
    const codePoint = character.codePointAt(0) ?? 0;
    safe += isUnsafeCodePoint(codePoint)
      ? `[U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}]`
      : character;
  }
  return safe;
};

const boundedText = (value: string, maxChars: number): string => {
  const safe = safeText(value);
  if (safe.length <= maxChars) return safe;
  const prefixLength = Math.max(0, maxChars - TRUNCATION_MARKER.length - 1);
  let prefix = '';
  for (const character of safe) {
    if (prefix.length + character.length > prefixLength) break;
    prefix += character;
  }
  return `${prefix} ${TRUNCATION_MARKER}`;
};

const boundedField = (value: unknown, fallback = 'unknown'): string => (
  boundedText(typeof value === 'string' ? value : value === undefined ? fallback : String(value), MAX_FIELD_CHARS)
);

const reasonLabel = (reason: SupervisorReason | undefined): string => {
  if (reason === 'interview_request') return 'Interview';
  if (reason === 'progress_update') return 'Progress';
  return 'Decision';
};

const supervisorReplyHint = (requestId: string): string => (
  `subagent_supervisor({ action: "reply", replyTo: "${requestId}", message: "..." })`
);

const validRequestDetails = (value: unknown): Record<string, unknown> | undefined => {
  if (!isRecord(value)) return undefined;
  if (
    !isOptionalString(value.id) || !isOptionalString(value.requestId) || !isOptionalString(value.replyHint)
    || !isOptionalString(value.requestBody) || !isOptionalString(value.runId) || !isOptionalString(value.agent)
    || !isOptionalString(value.childTarget)
  ) return undefined;
  if (value.reason !== undefined && !isSupervisorReason(value.reason)) return undefined;
  if (value.expectsReply !== undefined && typeof value.expectsReply !== 'boolean') return undefined;
  if (value.childIndex !== undefined && !isFiniteNumber(value.childIndex)) return undefined;
  return value;
};

const interviewText = (interview: unknown): string => {
  let serialized: string;
  try {
    serialized = JSON.stringify(interview, null, 2) ?? String(interview);
  } catch {
    serialized = '[unavailable]';
  }
  return boundedText(serialized, MAX_INTERVIEW_CHARS);
};

/** Parse a `subagent_supervisor_request` custom message; `undefined` when the payload is not valid. */
export const parseSupervisorRequest = (input: {
  customType?: string;
  text?: string;
  details?: unknown;
}): SupervisorRequest | undefined => {
  if (input.customType !== SUPERVISOR_REQUEST_MESSAGE_TYPE) return undefined;
  const details = validRequestDetails(input.details);
  if (!details) return undefined;

  const reason = details.reason as SupervisorReason | undefined;
  const requestId = boundedField(details.requestId ?? details.id);
  const body = (details.requestBody as string | undefined) ?? input.text ?? '';
  const rows: SupervisorDetail[] = [
    { label: 'Run', value: boundedField(details.runId) },
    { label: 'Child index', value: boundedField(details.childIndex) },
  ];
  if (typeof details.childTarget === 'string' && details.childTarget.length > 0) {
    rows.push({ label: 'Child target', value: boundedField(details.childTarget) });
  }
  rows.push({ label: 'Request ID', value: requestId });
  if (details.expectsReply === true) {
    rows.push({
      label: 'Reply with',
      value: boundedText((details.replyHint as string | undefined) ?? supervisorReplyHint(requestId), MAX_BODY_CHARS),
    });
  }
  if (details.interview !== undefined) {
    rows.push({ label: 'Interview shape', value: interviewText(details.interview) });
  }

  return {
    agent: boundedField(details.agent),
    reasonLabel: reasonLabel(reason),
    question: boundedText(body.length > 0 ? body : '(no request body)', MAX_BODY_CHARS),
    details: rows,
  };
};

const firstLine = (value: string): string => {
  for (const line of value.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed.length > MAX_SUMMARY_CHARS ? `${trimmed.slice(0, MAX_SUMMARY_CHARS - 1)}…` : trimmed;
  }
  return '';
};

/** Parse a `subagent_supervisor_reply` custom entry; `undefined` when the payload is not valid. */
export const parseSupervisorReply = (input: {
  customType?: string;
  data?: unknown;
}): SupervisorReply | undefined => {
  if (input.customType !== SUPERVISOR_REPLY_ENTRY_TYPE) return undefined;
  const data = input.data;
  if (!isRecord(data)) return undefined;
  if (
    typeof data.requestId !== 'string' || typeof data.runId !== 'string'
    || typeof data.agent !== 'string' || typeof data.message !== 'string'
  ) return undefined;
  if (data.reason !== undefined && !isSupervisorReason(data.reason)) return undefined;
  if (data.childTarget !== undefined && typeof data.childTarget !== 'string') return undefined;
  if (!isFiniteNumber(data.childIndex) || !isFiniteNumber(data.createdAt)) return undefined;

  const message = boundedText(data.message.length > 0 ? data.message : '(empty reply)', MAX_BODY_CHARS);
  const rows: SupervisorDetail[] = [];
  if (data.reason !== undefined) rows.push({ label: 'Reason', value: reasonLabel(data.reason) });
  rows.push(
    { label: 'Run', value: boundedField(data.runId) },
    { label: 'Child index', value: boundedField(data.childIndex) },
  );
  if (data.childTarget) rows.push({ label: 'Child target', value: boundedField(data.childTarget) });
  rows.push({ label: 'Reply to', value: boundedField(data.requestId) });

  return {
    agent: boundedField(data.agent),
    summary: firstLine(message),
    message,
    details: rows,
  };
};
