import * as React from 'react';

import { usePiSessionSnapshot } from '@/sync/pi-session-context';
import { cn } from '@/lib/utils';
import { containsAnsiEscape, extractAnsiTruecolor, stripAnsi } from '@/lib/pi/ansi';
import { SUBAGENT_ASYNC_WIDGET_KEY, SUBAGENT_INSPECT_WIDGET_KEY } from '@/lib/pi/subagentStatusSnapshot';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { useUIStore } from '@/stores/useUIStore';
import { parsePermissionStatus } from '@/lib/pi/permissions';
import { PermissionsControls } from './PermissionsControls';
import { SubagentStatusWidget } from './SubagentStatusWidget';

/**
 * Live pi extension surfaces for the selected session: footer-style status
 * entries (`ctx.ui.setStatus`) and editor widgets (`ctx.ui.setWidget` lines).
 */

const stripEquality = (a: unknown[], b: unknown[]): boolean => (
  a.length === b.length && a.every((item, index) => item === b[index])
);

// Pi TUI extensions color status text with raw ANSI (dotfiles `modes.ts`
// uses 24-bit sequences for per-mode colors, `token-speed.ts` uses
// `ctx.ui.theme.fg`). Strip the escapes and, when a truecolor is present,
// preserve it as CSS so mode identity survives on the web surface.
function renderStatusText(text: string): React.ReactNode {
  // Fast path: no ESC at all
  if (!containsAnsiEscape(text)) return text;
  const clean = stripAnsi(text);
  const color = extractAnsiTruecolor(text);
  if (!color) return clean;
  // Keep the whole segment in the mode color; the surrounding pill already
  // provides muted background/border so colored text is enough to recover
  // the per-mode identity from the TUI without a full ANSI parser.
  return <span style={{ color }}>{clean}</span>;
}

const pluralize = (count: number, singular: string, plural: string): string => (
  count === 1 ? `1 ${singular}` : `${count} ${plural}`
);

/** The one small button a collapsed extension surface leaves behind. */
const CollapsedExtensionButton: React.FC<{
  text: string;
  count: number;
  label: string;
  onExpand: () => void;
  className?: string;
}> = ({ text, count, label, onExpand, className }) => (
  <div className={cn('chat-input-column', className)}>
    <div className="flex">
      <Button
        variant="outline"
        size="xs"
        className="gap-1.5"
        aria-label={label}
        aria-expanded={false}
        title={label}
        onClick={onExpand}
      >
        <Icon name="plug-2" className="size-3.5" />
        <span>{text}</span>
        <span className="tabular-nums">{count}</span>
      </Button>
    </div>
  </div>
);

const CollapseButton: React.FC<{ label: string; className?: string; onCollapse: () => void }> = ({ label, className, onCollapse }) => (
  <Button
    variant="ghost"
    size="icon"
    className={cn('size-6 shrink-0 rounded-full', className)}
    aria-label={label}
    aria-expanded
    title={label}
    onClick={onCollapse}
  >
    <Icon name="arrow-down-s" className="size-4" />
  </Button>
);

type ExtensionStatusEntry = [key: string, text: string];

export const ExtensionStatusPill: React.FC<{
  statuses: readonly ExtensionStatusEntry[];
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
}> = ({ statuses, collapsed, onCollapsedChange }) => {
  if (statuses.length === 0) return null;

  if (collapsed) {
    return (
      <CollapsedExtensionButton
        text="Status"
        count={statuses.length}
        label={`Show extension status, ${pluralize(statuses.length, 'entry', 'entries')}`}
        onExpand={() => onCollapsedChange(false)}
      />
    );
  }

  return (
    <div className="chat-input-column">
      <div className="flex min-w-0 items-center gap-2 overflow-hidden rounded-full border border-border/40 bg-card px-3 py-1.5 shadow-sm transition-[opacity,transform] duration-150">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-interactive-hover text-muted-foreground">
          <Icon name="plug-2" className="size-3" />
        </span>
        <div className="flex min-w-0 flex-1 flex-nowrap items-center gap-1.5 overflow-x-auto overflow-y-hidden overscroll-x-contain scrollbar-hidden touch-pan-x" data-no-drawer-swipe="true">
          {statuses.map(([key, text]) => {
            if (key === 'permissions' && activeSessionId && parsePermissionStatus(text)) {
              return <PermissionsControls key={`${key}:${activeSessionId}`} sessionId={activeSessionId} text={text} />;
            }
            const color = extractAnsiTruecolor(text);
            return (
              <span
                key={key}
                className="inline-flex shrink-0 items-center whitespace-nowrap rounded-full border px-2 py-0.5 typography-micro font-medium"
                style={
                  color
                    ? {
                        color,
                        borderColor: `color-mix(in srgb, ${color} 28%, var(--border))`,
                        background: `color-mix(in srgb, ${color} 12%, var(--muted))`,
                      }
                    : undefined
                }
              >
                <span className={cn(!color && "text-muted-foreground")}>
                  {renderStatusText(text)}
                </span>
              </span>
            );
          })}
        </div>
        <CollapseButton label="Hide extension status" onCollapse={() => onCollapsedChange(true)} />
      </div>
    </div>
  );
};

export const ExtensionStatusStrip: React.FC<{ sessionId?: string | null }> = ({ sessionId }) => {
  const selectedSessionId = usePiSessionSnapshot((state) => state.selectedSessionId);
  const activeSessionId = sessionId ?? selectedSessionId;
  const collapsed = useUIStore((state) => state.extensionStatusCollapsed === true);
  const setCollapsed = useUIStore((state) => state.setExtensionStatusCollapsed);

  const statuses = usePiSessionSnapshot(
    (state) => {
      const session = activeSessionId ? state.reducer.bySession.get(activeSessionId) : undefined;
      return [...(session?.extensionStatuses.entries() ?? [])];
    },
    (a, b) => stripEquality(a.flat(), b.flat()),
    `session:${activeSessionId ?? ''}`,
  );

  return <ExtensionStatusPill statuses={statuses} collapsed={collapsed} onCollapsedChange={setCollapsed} />;
};

/**
 * IDs of extension notices already surfaced as toasts in this tab.
 *
 * Module scope (not a per-instance ref) is load-bearing: chat branches
 * unmount/remount this component as a session moves between loading, working,
 * and settled-empty views. A notice that arrived while the working branch was
 * mounted must still be "shown" when the settled branch mounts, and a notice
 * that arrived while no branch was mounted must toast on the next mount
 * rather than being seeded away as historical. Reconnect replays can re-toast
 * a recent notice after a reload; that references a real event and is cheaper
 * than swallowing routine command confirmations. Bounded so long-lived tabs
 * cannot grow it without limit.
 */
const shownExtensionNoticeIds = new Set<string>();
const MAX_SHOWN_EXTENSION_NOTICE_IDS = 200;

const markExtensionNoticeShown = (id: string): void => {
  shownExtensionNoticeIds.add(id);
  while (shownExtensionNoticeIds.size > MAX_SHOWN_EXTENSION_NOTICE_IDS) {
    const oldest = shownExtensionNoticeIds.values().next().value;
    if (oldest === undefined) break;
    shownExtensionNoticeIds.delete(oldest);
  }
};

/** Fire-and-forget ctx.ui.notify calls surface as transient toasts. */
export const ExtensionNoticeToasts: React.FC<{ sessionId?: string | null }> = ({ sessionId }) => {
  const selectedSessionId = usePiSessionSnapshot((state) => state.selectedSessionId);
  const activeSessionId = sessionId ?? selectedSessionId;

  const notices = usePiSessionSnapshot(
    (state) => {
      const session = activeSessionId ? state.reducer.bySession.get(activeSessionId) : undefined;
      return session?.extensionNotices ?? [];
    },
    (a, b) => a.length === b.length && a.every((notice, index) => notice.id === b[index]?.id),
    `session:${activeSessionId ?? ''}`,
  );

  React.useEffect(() => {
    for (const notice of notices) {
      if (shownExtensionNoticeIds.has(notice.id)) continue;
      markExtensionNoticeShown(notice.id);
      const message = stripAnsi(notice.message || 'Extension notification');
      if (notice.level === 'error') toast.error(message);
      else if (notice.level === 'warning') toast.warning(message);
      else toast.info(message);
    }
  }, [notices]);

  return null;
};

type ExtensionWidgetEntry = [key: string, widget: { lines: string[]; placement: 'aboveEditor' | 'belowEditor' }];

const widgetEntriesEqual = (a: ExtensionWidgetEntry[], b: ExtensionWidgetEntry[]): boolean => (
  a.length === b.length && a.every(([key, widget], index) => {
    const other = b[index];
    return other !== undefined && key === other[0] && widget.placement === other[1].placement && stripEquality(widget.lines, other[1].lines);
  })
);

export const ExtensionWidgetCard: React.FC<{
  widgets: readonly ExtensionWidgetEntry[];
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  className?: string;
}> = ({ widgets, collapsed, onCollapsedChange, className }) => {
  // `subagent-inspect` carries on-demand inspect replies for hosts that opt
  // in; pi-subagents asks every other host not to render it.
  const visible = widgets.filter(([key]) => key !== SUBAGENT_INSPECT_WIDGET_KEY);
  if (visible.length === 0) return null;

  if (collapsed) {
    return (
      <CollapsedExtensionButton
        text="Extensions"
        count={visible.length}
        label={`Show extension widgets, ${pluralize(visible.length, 'widget', 'widgets')}`}
        onExpand={() => onCollapsedChange(false)}
        className={className}
      />
    );
  }

  return (
    <div className={cn('chat-input-column', className)}>
      <div className="rounded-xl border border-border/60 bg-card p-3 shadow-sm transition-[opacity,transform] duration-150">
        <div className="mb-2 flex items-center gap-1.5 border-b border-border/40 pb-2">
          <Icon name="plug-2" className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="typography-micro font-medium uppercase tracking-wide text-muted-foreground">
            Extensions
          </span>
          <CollapseButton label="Hide extension widgets" className="-my-1 ml-auto" onCollapse={() => onCollapsedChange(true)} />
        </div>
        <div className="flex flex-col gap-2">
          {visible.map(([key, widget]) => (
            key === SUBAGENT_ASYNC_WIDGET_KEY ? (
              <div
                key={key}
                className="rounded-lg border border-border/30 bg-muted/40 px-2.5 py-2 leading-relaxed text-foreground"
              >
                <SubagentStatusWidget lines={widget.lines} />
              </div>
            ) : (
              <div
                key={key}
                className="rounded-lg border border-border/30 bg-muted/40 px-2.5 py-2 font-mono text-xs leading-relaxed text-foreground"
              >
                {widget.lines.map((line, index) => (
                  <span key={index} className="block whitespace-pre-wrap">
                    {containsAnsiEscape(line) ? stripAnsi(line) : line}
                  </span>
                ))}
              </div>
            )
          ))}
        </div>
      </div>
    </div>
  );
};

export const ExtensionWidgetStrip: React.FC<{
  sessionId?: string | null;
  placement?: 'aboveEditor' | 'belowEditor';
  className?: string;
}> = ({ sessionId, placement = 'aboveEditor', className }) => {
  const selectedSessionId = usePiSessionSnapshot((state) => state.selectedSessionId);
  const activeSessionId = sessionId ?? selectedSessionId;
  const collapsed = useUIStore((state) => state.extensionWidgetsCollapsed === true);
  const setCollapsed = useUIStore((state) => state.setExtensionWidgetsCollapsed);

  // Filtering inside the selector keeps hidden `subagent-inspect` updates from
  // re-rendering the card, and the line comparison avoids joining large
  // snapshot lines on every session event.
  const widgets = usePiSessionSnapshot(
    (state): ExtensionWidgetEntry[] => {
      const session = activeSessionId ? state.reducer.bySession.get(activeSessionId) : undefined;
      return [...(session?.extensionWidgets.entries() ?? [])]
        .filter(([key, widget]) => widget.placement === placement && key !== SUBAGENT_INSPECT_WIDGET_KEY);
    },
    widgetEntriesEqual,
    `session:${activeSessionId ?? ''}`,
  );

  return <ExtensionWidgetCard widgets={widgets} collapsed={collapsed} onCollapsedChange={setCollapsed} className={className} />;
};
