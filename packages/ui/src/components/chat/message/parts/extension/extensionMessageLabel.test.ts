import { describe, expect, test } from 'bun:test';

import { extensionKindLabel, extensionMessageSummary, extensionRunLabel } from './extensionMessageLabel';

describe('extensionKindLabel', () => {
    test('turns custom types into readable names', () => {
        expect(extensionKindLabel('intercom_message')).toBe('Intercom');
        expect(extensionKindLabel('subagent-notify')).toBe('Subagent notify');
        expect(extensionKindLabel('subagent-incremental-child-notify')).toBe('Subagent incremental child notify');
        expect(extensionKindLabel('sandyContext')).toBe('Sandy context');
        expect(extensionKindLabel('message')).toBe('Message');
        expect(extensionKindLabel(undefined)).toBe('Extension');
        expect(extensionKindLabel('__')).toBe('Extension');
    });
});

describe('extensionMessageSummary', () => {
    test('takes the leading bold span of an intercom message without its markers', () => {
        expect(extensionMessageSummary('**From #137 mobile composer (task-medium)** (/home/u/wt)\n\nbody'))
            .toBe('From #137 mobile composer (task-medium)');
    });

    test('takes the first non-empty line and strips inline Markdown', () => {
        expect(extensionMessageSummary('\n\n## Run `abc` **done** in [log](http://x)\nmore'))
            .toBe('Run abc done in log');
        expect(extensionMessageSummary('Background task _finished_')).toBe('Background task finished');
    });

    test('keeps identifiers with underscores and bounds long lines', () => {
        expect(extensionMessageSummary('call snake_case_name now')).toBe('call snake_case_name now');
        expect(extensionMessageSummary('x'.repeat(500))?.length).toBe(201);
    });

    test('returns nothing for empty text', () => {
        expect(extensionMessageSummary(undefined)).toBeUndefined();
        expect(extensionMessageSummary('  \n ')).toBeUndefined();
    });
});

describe('extensionRunLabel', () => {
    test('counts with explicit singular and plural', () => {
        expect(extensionRunLabel('intercom_message', 9)).toBe('9 Intercom messages');
        expect(extensionRunLabel('intercom_message', 1)).toBe('1 Intercom message');
    });
});
