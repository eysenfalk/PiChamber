import * as React from 'react';

import type { ChatMessageEntry } from '../../../lib/turns/types';
import { ExtensionDisclosureRow } from './ExtensionDisclosureRow';
import { ExtensionMessageCard } from './ExtensionMessageCard';
import { ExtensionMessageFrame } from './ExtensionMessageFrame';
import { extensionMessageSummary, extensionRunLabel } from './extensionMessageLabel';

type ExtensionInfo = {
    sessionID?: string;
    customType?: string;
    text?: unknown;
    data?: unknown;
    details?: unknown;
};

const infoOf = (message: ChatMessageEntry): ExtensionInfo => message.info as ExtensionInfo;
const textOf = (message: ChatMessageEntry): string | undefined => {
    const text = infoOf(message).text;
    return typeof text === 'string' ? text : undefined;
};

interface ExtensionMessageRunProps {
    customType: string;
    messages: ChatMessageEntry[];
    defaultExpanded?: boolean;
}

/**
 * Consecutive extension messages of one custom type as one collapsed row:
 * count and kind, plus the latest message's summary. Expanded, each message
 * is its own collapsed row. Messages mount only while the run is expanded.
 */
export const ExtensionMessageRun = React.memo(({ customType, messages, defaultExpanded }: ExtensionMessageRunProps) => {
    const first = messages[0];
    const latest = messages[messages.length - 1];
    if (!first || !latest) return null;
    const label = extensionRunLabel(customType, messages.length);
    const latestSummary = extensionMessageSummary(textOf(latest));

    return (
        <ExtensionMessageFrame messageId={first.info.id}>
            <ExtensionDisclosureRow
                messageId={first.info.id}
                icon="stack"
                label={label}
                defaultExpanded={defaultExpanded}
                dataAttributes={{ 'data-extension-run': String(messages.length), 'data-extension-type': customType }}
                summary={(
                    <>
                        <span className="font-medium text-foreground">{label}</span>
                        {latestSummary !== undefined && <span> · {latestSummary}</span>}
                    </>
                )}
            >
                <div className="flex flex-col">
                    {messages.map((message) => {
                        const info = infoOf(message);
                        return (
                            <ExtensionMessageCard
                                key={message.info.id}
                                sessionId={info.sessionID}
                                messageId={message.info.id}
                                customType={info.customType}
                                text={textOf(message)}
                                data={info.data}
                                details={info.details}
                            />
                        );
                    })}
                </div>
            </ExtensionDisclosureRow>
        </ExtensionMessageFrame>
    );
});

ExtensionMessageRun.displayName = 'ExtensionMessageRun';
