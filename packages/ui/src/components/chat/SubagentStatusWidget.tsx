import * as React from 'react';

import { cn } from '@/lib/utils';
import {
  parseSubagentStatusLine,
  type SubagentStatusNode,
  type SubagentStatusSnapshot,
  type SubagentStatusState,
} from '@/lib/pi/subagentStatusSnapshot';

/**
 * Native view of the async subagent snapshot (`subagent-async` widget). Elapsed
 * and last-activity times are measured against the snapshot's own
 * `generatedAt`, so the view needs no timer: pi-subagents republishes the
 * snapshot while runs are live and each update refreshes the numbers.
 */

const STATE_DOT_CLASS: Record<SubagentStatusState, string> = {
  queued: 'bg-muted-foreground/50',
  running: 'bg-[var(--status-info)]',
  complete: 'bg-[var(--status-success)]',
  failed: 'bg-[var(--status-error)]',
  rejected: 'bg-[var(--status-error)]',
  partial: 'bg-[var(--status-warning)]',
  paused: 'bg-[var(--status-warning)]',
  stopped: 'bg-[var(--status-warning)]',
};

const INDENT_PX = 14;

const formatDuration = (milliseconds: number): string => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
};

const nodeTiming = (node: SubagentStatusNode, generatedAt: number): string | null => {
  const live = node.state === 'running' || node.state === 'queued';
  if (node.startedAt !== undefined && node.state !== 'queued') {
    const end = live ? generatedAt : node.endedAt ?? node.updatedAt ?? generatedAt;
    return formatDuration(end - node.startedAt);
  }
  const lastActive = node.activity?.lastActivityAt ?? node.updatedAt;
  return lastActive === undefined ? null : `${formatDuration(generatedAt - lastActive)} ago`;
};

const omittedText = (omitted: SubagentStatusSnapshot['omitted']): string | null => {
  const parts: string[] = [];
  if (omitted.runs > 0) parts.push(omitted.runs === 1 ? '1 more run' : `${omitted.runs} more runs`);
  if (omitted.children > 0) parts.push(omitted.children === 1 ? '1 nested run' : `${omitted.children} nested runs`);
  return parts.length > 0 ? `${parts.join(' and ')} not shown` : null;
};

const StatusRows: React.FC<{ nodes: readonly SubagentStatusNode[]; depth: number; generatedAt: number }> = ({ nodes, depth, generatedAt }) => (
  <>
    {nodes.map((node, index) => {
      const timing = nodeTiming(node, generatedAt);
      const currentTool = node.activity?.currentTool;
      return (
        <React.Fragment key={`${node.id}:${index}`}>
          <li
            className="flex min-w-0 items-center gap-2 py-0.5"
            style={depth > 0 ? { paddingLeft: depth * INDENT_PX } : undefined}
          >
            <span
              role="img"
              aria-label={node.state}
              title={node.state}
              className={cn('size-2 shrink-0 rounded-full', STATE_DOT_CLASS[node.state])}
            />
            <span className="min-w-0 flex-1 truncate text-foreground">{node.label}</span>
            {currentTool ? (
              <span className="max-w-[40%] shrink-0 truncate rounded border border-border/40 bg-muted px-1.5 font-mono typography-micro text-muted-foreground">
                {currentTool}
              </span>
            ) : null}
            {timing ? (
              <span className="shrink-0 tabular-nums typography-micro text-muted-foreground">{timing}</span>
            ) : null}
          </li>
          {node.children ? <StatusRows nodes={node.children} depth={depth + 1} generatedAt={generatedAt} /> : null}
        </React.Fragment>
      );
    })}
  </>
);

export const SubagentStatusWidget: React.FC<{ lines: readonly string[] }> = ({ lines }) => {
  const line = lines[0] ?? '';
  const parsed = React.useMemo(() => parseSubagentStatusLine(line), [line]);

  if (!parsed.ok) {
    return <span className="typography-micro text-muted-foreground">Subagent status unavailable</span>;
  }

  const { snapshot } = parsed;
  const omitted = omittedText(snapshot.omitted);
  return (
    <div className="flex flex-col gap-1 text-xs">
      <span className="typography-micro font-medium uppercase tracking-wide text-muted-foreground">Subagents</span>
      {snapshot.runs.length > 0 ? (
        <ul className="flex flex-col">
          <StatusRows nodes={snapshot.runs} depth={0} generatedAt={snapshot.generatedAt} />
        </ul>
      ) : (
        <span className="typography-micro text-muted-foreground">No subagent runs</span>
      )}
      {omitted ? <span className="typography-micro text-muted-foreground">{omitted}</span> : null}
    </div>
  );
};
