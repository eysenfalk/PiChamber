import { describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { Message, Part } from '@/lib/chat/types';

mock.module('@/components/chat/MarkdownRenderer', () => ({
    MarkdownRenderer: (props: { content?: unknown }) => React.createElement(
        'div',
        { 'data-markdown-content': 'true' },
        typeof props.content === 'string' ? props.content : '',
    ),
    SimpleMarkdownRenderer: () => null,
}));

const { ExtensionMessageRun } = await import('./ExtensionMessageRun');

const intercom = (id: string, sender: string) => ({
    info: {
        id,
        sessionID: 's',
        role: 'extension',
        customType: 'intercom_message',
        text: `**From ${sender}** (/home/u/wt)\n\nHello from ${sender}`,
        time: { created: 1 },
    } as Message,
    parts: [] as Part[],
});

const messages = [intercom('a', '#137 mobile composer'), intercom('b', '#140 lab'), intercom('c', '#141 docs')];

describe('ExtensionMessageRun', () => {
    test('collapses a run into one row in the chat column with count, kind and the latest sender', () => {
        const markup = renderToStaticMarkup(<ExtensionMessageRun customType="intercom_message" messages={messages} />);
        expect(markup).toContain('class="chat-message-column"');
        expect(markup).toContain('data-message-id="a"');
        expect(markup).toContain('data-extension-run="3"');
        expect(markup).toContain('3 Intercom messages');
        expect(markup).toContain('From #141 docs');
        expect(markup).toContain('aria-expanded="false"');
        // Members mount only once the run is expanded.
        expect(markup).not.toContain('From #137 mobile composer');
    });

    test('expanded, each message is its own collapsed row', () => {
        const markup = renderToStaticMarkup(
            <ExtensionMessageRun customType="intercom_message" messages={messages} defaultExpanded />,
        );
        expect(markup).toContain('data-extension-ui="b"');
        expect(markup).toContain('From #137 mobile composer');
        expect(markup).toContain('From #140 lab');
        expect(markup.match(/data-extension-disclosure="collapsed"/g)).toHaveLength(3);
    });
});
