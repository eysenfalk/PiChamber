import * as React from 'react';

/**
 * Places extension rows in the chat message column, like `ChatMessage`, and
 * gives them the message anchor (`data-message-id`) that scrolling and
 * viewport restore look up.
 */
export const ExtensionMessageFrame: React.FC<{ messageId: string; children: React.ReactNode }> = ({
    messageId,
    children,
}) => (
    <div className="w-full" id={`message-${messageId}`} data-message-id={messageId}>
        <div className="chat-message-column">{children}</div>
    </div>
);
