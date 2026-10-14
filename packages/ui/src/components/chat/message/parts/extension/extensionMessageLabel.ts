/**
 * Readable labels for extension messages without a PiChamber renderer
 * (`pi.sendMessage` from intercom, subagents, context plugins and any other
 * extension). One generic rule for every custom type: no per-type table.
 */

const MAX_SUMMARY_LENGTH = 200;

/**
 * Human name of a custom type: `intercom_message` -> `Intercom`,
 * `subagent-notify` -> `Subagent notify`. A trailing `message` word is dropped
 * because the row and group copy already say message.
 */
export const extensionKindLabel = (customType: string | undefined): string => {
    const words = (customType ?? '')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .split(/[^A-Za-z0-9]+/)
        .filter((word) => word.length > 0)
        .map((word) => word.toLowerCase());
    while (words.length > 1 && /^messages?$/.test(words[words.length - 1] ?? '')) words.pop();
    if (words.length === 0) return 'Extension';
    const text = words.join(' ');
    return text.charAt(0).toUpperCase() + text.slice(1);
};

const stripInlineMarkdown = (line: string): string => line
    .replace(/^(#{1,6}\s+|>\s*|[-*+]\s+)/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_]([^*_\s](?:[^*_]*[^*_\s])?)[*_](?=[^\w*]|$)/g, '$1$2')
    .trim();

/**
 * One plain-text line that says what the message is: the first non-empty line,
 * or only its leading bold span when it opens with one (intercom's
 * `**From <sender>** (<cwd>)`), with inline Markdown removed.
 */
export const extensionMessageSummary = (text: string | undefined): string | undefined => {
    const line = text?.split('\n').map((value) => value.trim()).find((value) => value.length > 0);
    if (!line) return undefined;
    const leadingBold = /^(\*\*|__)(.+?)\1/.exec(line);
    const summary = stripInlineMarkdown(leadingBold?.[2] ?? line);
    if (summary.length === 0) return undefined;
    return summary.length > MAX_SUMMARY_LENGTH ? `${summary.slice(0, MAX_SUMMARY_LENGTH)}…` : summary;
};

/** Collapsed label of a run of same-type messages, e.g. `9 Intercom messages`. */
export const extensionRunLabel = (customType: string | undefined, count: number): string => (
    `${count} ${extensionKindLabel(customType)} ${count === 1 ? 'message' : 'messages'}`
);
