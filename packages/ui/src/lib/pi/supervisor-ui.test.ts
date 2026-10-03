import { describe, expect, test } from 'bun:test';

import {
  parseSupervisorReply,
  parseSupervisorRequest,
  SUPERVISOR_REPLY_ENTRY_TYPE,
  SUPERVISOR_REQUEST_MESSAGE_TYPE,
} from './supervisor-ui';

const requestDetails = (overrides: Record<string, unknown> = {}) => ({
  id: 'req-1',
  requestId: 'req-1',
  reason: 'need_decision',
  expectsReply: true,
  runId: 'run-7',
  agent: 'worker',
  childIndex: 2,
  requestBody: 'Which migration path should I take?',
  replyHint: 'subagent_supervisor({ action: "reply", replyTo: "req-1", message: "..." })',
  ...overrides,
});

const replyData = (overrides: Record<string, unknown> = {}) => ({
  requestId: 'req-1',
  reason: 'need_decision',
  runId: 'run-7',
  agent: 'worker',
  childIndex: 2,
  message: '\n  Use path B.\nIt keeps the old API.',
  createdAt: 1_700_000_000_000,
  ...overrides,
});

describe('parseSupervisorRequest', () => {
  test('projects agent, reason label, question and the disclosure details', () => {
    const request = parseSupervisorRequest({
      customType: SUPERVISOR_REQUEST_MESSAGE_TYPE,
      text: 'visible text that the details body replaces',
      details: requestDetails({ childTarget: 'reviewer' }),
    });

    expect(request?.agent).toBe('worker');
    expect(request?.reasonLabel).toBe('Decision');
    expect(request?.question).toBe('Which migration path should I take?');
    expect(request?.details.map((row) => row.label)).toEqual(['Run', 'Child index', 'Child target', 'Request ID', 'Reply with']);
    expect(request?.details.find((row) => row.label === 'Request ID')?.value).toBe('req-1');
  });

  test('labels interview and progress reasons and keeps the interview shape in the details', () => {
    const interview = parseSupervisorRequest({
      customType: SUPERVISOR_REQUEST_MESSAGE_TYPE,
      details: requestDetails({ reason: 'interview_request', interview: { questions: [{ id: 'q1' }] } }),
    });
    expect(interview?.reasonLabel).toBe('Interview');
    expect(interview?.details.at(-1)?.label).toBe('Interview shape');

    const progress = parseSupervisorRequest({
      customType: SUPERVISOR_REQUEST_MESSAGE_TYPE,
      details: requestDetails({ reason: 'progress_update', expectsReply: false }),
    });
    expect(progress?.reasonLabel).toBe('Progress');
    expect(progress?.details.some((row) => row.label === 'Reply with')).toBe(false);
  });

  test('falls back to the message text when the details carry no request body', () => {
    const request = parseSupervisorRequest({
      customType: SUPERVISOR_REQUEST_MESSAGE_TYPE,
      text: 'Text from the message content',
      details: requestDetails({ requestBody: undefined }),
    });
    expect(request?.question).toBe('Text from the message content');
  });

  test('rejects other custom types and every invalid details shape without throwing', () => {
    const invalid: unknown[] = [
      undefined,
      null,
      'details',
      ['list'],
      requestDetails({ reason: 'surprise' }),
      requestDetails({ agent: 42 }),
      requestDetails({ expectsReply: 'yes' }),
      requestDetails({ childIndex: Number.NaN }),
      requestDetails({ childIndex: '2' }),
      requestDetails({ requestBody: { text: 'object' } }),
    ];
    for (const details of invalid) {
      expect(parseSupervisorRequest({ customType: SUPERVISOR_REQUEST_MESSAGE_TYPE, details })).toBeUndefined();
    }
    expect(parseSupervisorRequest({ customType: 'other', details: requestDetails() })).toBeUndefined();
  });

  test('bounds long bodies and replaces control characters', () => {
    const request = parseSupervisorRequest({
      customType: SUPERVISOR_REQUEST_MESSAGE_TYPE,
      details: requestDetails({ requestBody: `${'x'.repeat(9_000)}`, agent: 'wor\u001b[31mker' }),
    });
    expect((request?.question.length ?? Infinity) <= 8_000).toBe(true);
    expect(request?.question.endsWith('[truncated]')).toBe(true);
    expect(request?.agent).toContain('[U+001B]');
    expect(request?.agent).not.toContain('\u001b');
  });
});

describe('parseSupervisorReply', () => {
  test('projects the first non-empty line as summary and keeps the full reply', () => {
    const reply = parseSupervisorReply({ customType: SUPERVISOR_REPLY_ENTRY_TYPE, data: replyData() });

    expect(reply?.agent).toBe('worker');
    expect(reply?.summary).toBe('Use path B.');
    expect(reply?.message).toContain('It keeps the old API.');
    expect(reply?.details.find((row) => row.label === 'Reply to')?.value).toBe('req-1');
  });

  test('shows a placeholder for an empty reply', () => {
    const reply = parseSupervisorReply({ customType: SUPERVISOR_REPLY_ENTRY_TYPE, data: replyData({ message: '' }) });
    expect(reply?.message).toBe('(empty reply)');
  });

  test('rejects other custom types and invalid data without throwing', () => {
    const invalid: unknown[] = [
      undefined,
      'data',
      replyData({ requestId: 1 }),
      replyData({ runId: undefined }),
      replyData({ message: 5 }),
      replyData({ reason: 'surprise' }),
      replyData({ childIndex: undefined }),
      replyData({ createdAt: Number.POSITIVE_INFINITY }),
      replyData({ childTarget: 3 }),
    ];
    for (const data of invalid) {
      expect(parseSupervisorReply({ customType: SUPERVISOR_REPLY_ENTRY_TYPE, data })).toBeUndefined();
    }
    expect(parseSupervisorReply({ customType: 'other', data: replyData() })).toBeUndefined();
  });
});
