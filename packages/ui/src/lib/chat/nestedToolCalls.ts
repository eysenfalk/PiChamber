/**
 * A tool call that ran inside another tool call. The session daemon projects
 * pi-fabric's `fabric_exec` details into `metadata.nestedCalls`, plus the
 * run's `progress` text and `phases`. This module is the UI side of that
 * contract and knows nothing about pi-fabric itself.
 */
export interface NestedToolCall {
    name: string;
    input?: Record<string, unknown>;
    /** Absent while the call has not reported an outcome. */
    success?: boolean;
    output?: string;
    error?: string;
    metadata?: Record<string, unknown>;
    startedAt?: number;
    endedAt?: number;
}

type NestedCallStatus = 'running' | 'completed' | 'error';

/** Rows shown while the card is compact, and when it is expanded. */
export const COMPACT_CALL_LIMIT = 8;
export const EXPANDED_CALL_LIMIT = 30;
/** Diff or content lines shown under the latest edit or write while compact. */
export const PREVIEW_LINE_LIMIT = 10;

const PREVIEW_CHAR_LIMIT = 1200;
const LIGHT_VALUE_CHARS = 300;

const isRecord = (value: unknown): value is Record<string, unknown> => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
);

const readNumber = (value: unknown): number | undefined => (
    typeof value === 'number' && Number.isFinite(value) ? value : undefined
);

export const readNestedToolCalls = (metadata: Record<string, unknown> | undefined): NestedToolCall[] => {
    const raw = metadata?.nestedCalls;
    if (!Array.isArray(raw)) {
        return [];
    }
    const calls: NestedToolCall[] = [];
    for (const entry of raw) {
        if (!isRecord(entry) || typeof entry.name !== 'string' || entry.name.length === 0) {
            continue;
        }
        calls.push({
            name: entry.name,
            ...(isRecord(entry.input) ? { input: entry.input } : {}),
            ...(typeof entry.success === 'boolean' ? { success: entry.success } : {}),
            ...(typeof entry.output === 'string' ? { output: entry.output } : {}),
            ...(typeof entry.error === 'string' ? { error: entry.error } : {}),
            ...(isRecord(entry.metadata) ? { metadata: entry.metadata } : {}),
            ...(readNumber(entry.startedAt) !== undefined ? { startedAt: readNumber(entry.startedAt) } : {}),
            ...(readNumber(entry.endedAt) !== undefined ? { endedAt: readNumber(entry.endedAt) } : {}),
        });
    }
    return calls;
};

/** The run's own progress line and phase names, as streamed while it runs. */
export const readRunProgress = (
    metadata: Record<string, unknown> | undefined,
): { progress: string; phases: string[] } => {
    const progress = typeof metadata?.progress === 'string' ? metadata.progress.trim() : '';
    const phases = Array.isArray(metadata?.phases)
        ? metadata.phases.filter((phase): phase is string => typeof phase === 'string' && phase.length > 0)
        : [];
    return { progress, phases };
};

export const resolveNestedCallStatus = (call: NestedToolCall, parentSettled: boolean): NestedCallStatus => {
    if (call.success === true) {
        return 'completed';
    }
    if (call.success === false) {
        return 'error';
    }
    // No reported outcome: still running only while the outer call runs.
    return parentSettled ? 'completed' : 'running';
};

interface NestedRunCounts {
    total: number;
    done: number;
    running: number;
    failed: number;
}

export const countNestedCalls = (calls: NestedToolCall[], parentSettled: boolean): NestedRunCounts => {
    let running = 0;
    let failed = 0;
    for (const call of calls) {
        const status = resolveNestedCallStatus(call, parentSettled);
        if (status === 'running') running += 1;
        else if (status === 'error') failed += 1;
    }
    return { total: calls.length, done: calls.length - running, running, failed };
};

/**
 * Which calls render. Expanded shows the first `EXPANDED_CALL_LIMIT`. Compact
 * shows everything up to `COMPACT_CALL_LIMIT`; past that, running calls take
 * the slots first and the earliest calls fill the rest, in original order.
 */
export const selectVisibleCallIndexes = (
    calls: NestedToolCall[],
    expanded: boolean,
    parentSettled: boolean,
): { indexes: number[]; hidden: number } => {
    const limit = expanded ? EXPANDED_CALL_LIMIT : COMPACT_CALL_LIMIT;
    if (expanded || calls.length <= limit) {
        const indexes = calls.slice(0, limit).map((_, index) => index);
        return { indexes, hidden: calls.length - indexes.length };
    }
    const selected = new Set<number>();
    const running: number[] = [];
    calls.forEach((call, index) => {
        if (resolveNestedCallStatus(call, parentSettled) === 'running') running.push(index);
    });
    for (const index of running.slice(-limit)) selected.add(index);
    for (let index = 0; index < calls.length && selected.size < limit; index += 1) {
        selected.add(index);
    }
    const indexes = [...selected].sort((a, b) => a - b);
    return { indexes, hidden: calls.length - indexes.length };
};

const headLines = (text: string): string[] => {
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    return lines.slice(0, PREVIEW_LINE_LIMIT);
};

const isWriteCall = (name: string): boolean => name === 'write' || name === 'create' || name === 'file_write';

/**
 * Diff lines shown under a successful edit or write while the card is compact.
 * Edits carry Pi's `+N text` / `-N text` diff; writes show the head of the
 * content they wrote, as added lines.
 */
export const readPreviewLines = (call: NestedToolCall): { text: string; kind: 'add' | 'remove' | 'context' }[] => {
    if (call.success !== true) return [];
    const diff = call.metadata?.diff;
    let lines: string[] = [];
    if (typeof diff === 'string' && diff.length > 0) {
        lines = headLines(diff);
    } else if (isWriteCall(call.name) && typeof call.input?.content === 'string') {
        lines = headLines(call.input.content).map((line) => `+${line}`);
    }
    return lines.map((text) => ({
        text,
        kind: text.startsWith('+') ? 'add' : text.startsWith('-') ? 'remove' : 'context',
    }));
};

const isEditLikeCall = (name: string): boolean => (
    name === 'edit' || name === 'multiedit' || isWriteCall(name)
);

/** The call that carries the preview: the last successful edit or write. */
export const findPreviewCallIndex = (calls: NestedToolCall[]): number => {
    for (let index = calls.length - 1; index >= 0; index -= 1) {
        const call = calls[index];
        if (isEditLikeCall(call.name) && readPreviewLines(call).length > 0) return index;
    }
    return -1;
};

const lightInput = (input: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
    if (!input) return undefined;
    const light: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
        if (typeof value === 'string' && value.length <= LIGHT_VALUE_CHARS) light[key] = value;
        else if (typeof value === 'number' || typeof value === 'boolean') light[key] = value;
    }
    return Object.keys(light).length > 0 ? light : undefined;
};

const LIGHT_METADATA_KEYS = ['additions', 'deletions', 'firstChangedLine', 'filePath', 'path'] as const;

const lightMetadata = (
    metadata: Record<string, unknown> | undefined,
    previewDiff: string | undefined,
): Record<string, unknown> | undefined => {
    const light: Record<string, unknown> = {};
    for (const key of LIGHT_METADATA_KEYS) {
        const value = metadata?.[key];
        if (typeof value === 'number' || (typeof value === 'string' && value.length <= LIGHT_VALUE_CHARS)) {
            light[key] = value;
        }
    }
    if (previewDiff) light.diff = previewDiff;
    return Object.keys(light).length > 0 ? light : undefined;
};

/**
 * Compact record for a settled `fabric_exec` whose full nested list is too big
 * to keep in the transcript. It keeps what the compact card draws (name, short
 * input, outcome, timing, change counts, and the preview of the latest edit or
 * write) and drops outputs and long text. Expanding the card hydrates the full
 * list.
 */
export const lightenNestedCalls = (calls: NestedToolCall[]): NestedToolCall[] => {
    const previewIndex = findPreviewCallIndex(calls);
    return calls.map((call, index) => {
        let previewDiff: string | undefined;
        let input = lightInput(call.input);
        if (index === previewIndex) {
            const lines = readPreviewLines(call).map((line) => line.text);
            const text = lines.join('\n').slice(0, PREVIEW_CHAR_LIMIT);
            if (typeof call.metadata?.diff === 'string') previewDiff = text;
            else if (text) input = { ...input, content: text.split('\n').map((line) => line.slice(1)).join('\n') };
        }
        const metadata = lightMetadata(call.metadata, previewDiff);
        return {
            name: call.name,
            ...(input ? { input } : {}),
            ...(call.success !== undefined ? { success: call.success } : {}),
            ...(call.error ? { error: call.error.slice(0, LIGHT_VALUE_CHARS) } : {}),
            ...(metadata ? { metadata } : {}),
            ...(call.startedAt !== undefined ? { startedAt: call.startedAt } : {}),
            ...(call.endedAt !== undefined ? { endedAt: call.endedAt } : {}),
        };
    });
};
