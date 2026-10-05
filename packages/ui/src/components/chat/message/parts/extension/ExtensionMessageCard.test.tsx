import { describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// The real renderer fills in after mount, so static markup would be empty.
mock.module('@/components/chat/MarkdownRenderer', () => ({
    MarkdownRenderer: (props: { content?: unknown }) => React.createElement(
        'div',
        { 'data-markdown-content': 'true' },
        typeof props.content === 'string' ? props.content : '',
    ),
    SimpleMarkdownRenderer: (props: { content?: unknown }) => React.createElement(
        'div',
        { 'data-markdown-content': 'true' },
        typeof props.content === 'string' ? props.content : '',
    ),
}));

const { ExtensionMessageCard } = await import('./ExtensionMessageCard');

const renderCard = (props: Partial<Parameters<typeof ExtensionMessageCard>[0]>) => renderToStaticMarkup(
    <ExtensionMessageCard messageId="m1" {...props} />,
);

describe('ExtensionMessageCard', () => {
    test('renders a progress card with label and percent', () => {
        const markup = renderCard({
            customType: 'pichamber.ui',
            data: { component: 'progress', props: { label: 'Indexing', value: 40, max: 200 } },
        });
        expect(markup).toContain('Indexing');
        expect(markup).toContain('20%');
        expect(markup).toContain('progressbar');
    });

    test('renders kv rows and badges with tones', () => {
        const markup = renderCard({
            customType: 'pichamber.ui',
            data: {
                title: 'Explore',
                component: 'kv',
                props: { rows: [{ label: 'Files', value: '12', tone: 'info' }] },
            },
        });
        expect(markup).toContain('Explore');
        expect(markup).toContain('Files');
        expect(markup).toContain('12');

        const badges = renderCard({
            customType: 'pichamber.ui',
            data: { component: 'badges', props: { items: [{ label: 'passing', tone: 'success' }] } },
        });
        expect(badges).toContain('passing');
    });

    test('renders action buttons bound to the session', () => {
        const markup = renderCard({
            sessionId: 'sess-1',
            customType: 'pichamber.ui',
            data: {
                component: 'markdown',
                props: { body: 'Done' },
                actions: [{ label: 'Reindex', command: 'explore-reindex' }],
            },
        });
        expect(markup).toContain('Reindex');
    });

    test('starts non-GUI extension content as one collapsed row with the custom type and first line', () => {
        const markup = renderCard({
            customType: 'my-extension',
            text: '\n  Status update\nsecond line',
            details: { count: 3 },
        });
        expect(markup).toContain('my-extension');
        expect(markup).toContain('Status update');
        expect(markup).toContain('aria-expanded="false"');
        expect(markup).toContain('data-extension-disclosure="collapsed"');
        expect(markup).not.toContain('<pre');
        expect(markup).not.toContain('second line');
    });

    test('expanding the fallback row shows the preformatted content', () => {
        const markup = renderCard({
            customType: 'my-extension',
            text: 'Status update',
            details: { count: 3 },
            defaultExpanded: true,
        });
        expect(markup).toContain('aria-expanded="true"');
        expect(markup).toContain('&quot;count&quot;: 3');
    });

    test('keeps GUI descriptor cards open', () => {
        const markup = renderCard({
            customType: 'pichamber.ui',
            data: { component: 'markdown', props: { body: 'Visible body' } },
        });
        expect(markup).toContain('Visible body');
        expect(markup).not.toContain('data-extension-disclosure');
    });
});

const supervisorRequestDetails = (overrides: Record<string, unknown> = {}) => ({
    id: 'req-1',
    requestId: 'req-1',
    reason: 'need_decision',
    expectsReply: true,
    runId: 'run-7',
    agent: 'worker',
    childIndex: 2,
    requestBody: 'Which **migration path** should I take?',
    replyHint: 'subagent_supervisor({ action: "reply", replyTo: "req-1", message: "..." })',
    ...overrides,
});

const supervisorReplyData = (overrides: Record<string, unknown> = {}) => ({
    requestId: 'req-1',
    reason: 'need_decision',
    runId: 'run-7',
    agent: 'worker',
    childIndex: 2,
    message: 'Use path B.\nIt keeps the old API.',
    createdAt: 1_700_000_000_000,
    ...overrides,
});

describe('ExtensionMessageCard supervisor rows', () => {
    test('renders a request as one compact row: agent, reason and question, details collapsed', () => {
        const markup = renderCard({
            customType: 'subagent_supervisor_request',
            text: 'Subagent needs a decision',
            details: supervisorRequestDetails(),
        });
        expect(markup).toContain('data-supervisor-message="request"');
        expect(markup).toContain('worker');
        expect(markup).toContain('Decision');
        expect(markup).toContain('migration path');
        expect(markup).toContain('aria-expanded="false"');
        for (const hidden of ['run-7', 'Child index', 'Request ID', 'Reply with', 'subagent_supervisor(']) {
            expect(markup).not.toContain(hidden);
        }
        expect(markup).not.toContain('<pre');
    });

    test('shows run, child index, request id and the reply hint once the details are open', () => {
        const markup = renderCard({
            customType: 'subagent_supervisor_request',
            details: supervisorRequestDetails(),
            defaultExpanded: true,
        });
        expect(markup).toContain('run-7');
        expect(markup).toContain('Child index');
        expect(markup).toContain('req-1');
        expect(markup).toContain('Reply with');
        expect(markup).toContain('aria-expanded="true"');
    });

    test('labels interview and progress requests', () => {
        expect(renderCard({
            customType: 'subagent_supervisor_request',
            details: supervisorRequestDetails({ reason: 'interview_request' }),
        })).toContain('Interview');
        expect(renderCard({
            customType: 'subagent_supervisor_request',
            details: supervisorRequestDetails({ reason: 'progress_update', expectsReply: false }),
        })).toContain('Progress');
    });

    test('renders a reply entry as one collapsed row "Reply to <agent>: <first line>"', () => {
        const markup = renderCard({
            customType: 'subagent_supervisor_reply',
            data: supervisorReplyData(),
        });
        expect(markup).toContain('data-supervisor-message="reply"');
        expect(markup).toContain('Reply to worker');
        expect(markup).toContain('Use path B.');
        expect(markup).toContain('aria-expanded="false"');
        expect(markup).not.toContain('It keeps the old API.');
        expect(markup).not.toContain('requestId');
    });

    test('expands a reply to the full message', () => {
        const markup = renderCard({
            customType: 'subagent_supervisor_reply',
            data: supervisorReplyData(),
            defaultExpanded: true,
        });
        expect(markup).toContain('aria-expanded="true"');
        expect(markup).toContain('It keeps the old API.');
    });

    test('falls back to the collapsed generic row for malformed supervisor payloads without throwing', () => {
        const malformed: Array<Parameters<typeof renderCard>[0]> = [
            { customType: 'subagent_supervisor_request', text: 'Needs a decision', details: { reason: 'surprise', agent: 7 } },
            { customType: 'subagent_supervisor_request', text: 'Needs a decision', details: 'not an object' },
            { customType: 'subagent_supervisor_request', text: 'Needs a decision' },
            { customType: 'subagent_supervisor_reply', data: { requestId: 1 } },
            { customType: 'subagent_supervisor_reply', data: null },
            { customType: 'subagent_supervisor_reply' },
        ];
        for (const props of malformed) {
            // A throw here fails the test: malformed payloads must render, not crash.
            const markup = renderCard(props);
            expect(markup).toContain(props.customType ?? '');
            expect(markup).toContain('data-extension-disclosure="collapsed"');
            expect(markup).not.toContain('data-supervisor-message');
        }
    });
});
