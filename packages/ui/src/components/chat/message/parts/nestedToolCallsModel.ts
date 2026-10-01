import type { ToolPart as ToolPartType } from '@/lib/chat/types';
import { resolveNestedCallStatus, type NestedToolCall } from '@/lib/chat/nestedToolCalls';

/** Synthetic tool parts so nested calls render through the normal tool row. */
export const buildNestedToolParts = (
    parentId: string,
    calls: NestedToolCall[],
    parentSettled: boolean,
): ToolPartType[] => calls.map((call, index) => ({
    id: `${parentId}:nested:${index}`,
    type: 'tool',
    tool: call.name,
    state: {
        status: resolveNestedCallStatus(call, parentSettled),
        input: call.input ?? {},
        ...(call.output !== undefined ? { output: call.output } : {}),
        ...(call.error !== undefined ? { error: call.error } : {}),
        ...(call.metadata ? { metadata: call.metadata } : {}),
        time: { start: call.startedAt, end: call.endedAt },
    },
}));
