import React from 'react';

import { useInputStore } from '@/sync/input-store';

import { appendInlineText, appendWithLineBreaks } from '../text';

type UsePendingComposerTextOptions = {
    /** Current draft; a pending revert only applies to an empty one. */
    message: string;
    setMessage: React.Dispatch<React.SetStateAction<string>>;
    /** Called once when pending text was actually put into the draft. */
    onApplied: () => void;
};

/**
 * Applies text other parts of the app hand to the composer: "Add to chat" and
 * reverted prompts. `onApplied` fires only for text that landed, so a caller
 * can reveal a minimized composer for an explicit user action and leave it
 * alone otherwise.
 */
export function usePendingComposerText({ message, setMessage, onApplied }: UsePendingComposerTextOptions) {
    const pendingInputText = useInputStore((s) => s.pendingInputText);
    const consumePendingInputText = useInputStore((s) => s.consumePendingInputText);
    const pendingRevertText = useInputStore((s) => s.pendingRevertText);
    const consumePendingRevertText = useInputStore((s) => s.consumePendingRevertText);

    React.useEffect(() => {
        if (pendingInputText === null) return;
        const pending = consumePendingInputText();
        if (!pending?.text) return;
        if (pending.mode === 'append') {
            setMessage((prev) => {
                const next = pending.text;
                if (!next.trim()) return prev;
                return appendWithLineBreaks(prev, next);
            });
        } else if (pending.mode === 'append-inline') {
            setMessage((prev) => appendInlineText(prev, pending.text));
        } else {
            setMessage(pending.text);
        }
        onApplied();
    }, [pendingInputText, consumePendingInputText, setMessage, onApplied]);

    // Only when the composer is empty: a revert never overwrites a draft.
    React.useEffect(() => {
        if (pendingRevertText === null) return;
        const text = consumePendingRevertText();
        if (text && message.trim().length === 0) {
            setMessage(text);
            onApplied();
        }
    }, [pendingRevertText, consumePendingRevertText, message, setMessage, onApplied]);
}
