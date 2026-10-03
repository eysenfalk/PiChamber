import { beforeEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

type FakeWidget = { lines: string[]; placement: 'aboveEditor' | 'belowEditor' };
type FakeSession = { extensionWidgets: Map<string, FakeWidget>; extensionStatuses: Map<string, string> };

const fakeSession: FakeSession = { extensionWidgets: new Map(), extensionStatuses: new Map() };
const fakeState = {
  selectedSessionId: 'session-1',
  reducer: { bySession: new Map([['session-1', fakeSession]]) },
};

mock.module('@/sync/pi-session-context', () => ({
  usePiSessionSnapshot: (selector: (state: typeof fakeState) => unknown) => selector(fakeState),
}));
const collapseCalls: string[] = [];
const fakeUi = {
  extensionWidgetsCollapsed: false,
  extensionStatusCollapsed: false,
  setExtensionWidgetsCollapsed: (value: boolean) => { collapseCalls.push(`widgets:${value}`); },
  setExtensionStatusCollapsed: (value: boolean) => { collapseCalls.push(`status:${value}`); },
};
// The strips read two leaf fields and their setters from the persisted UI
// store; the store itself is covered in useUIStore.extensionCollapse.test.ts.
mock.module('@/stores/useUIStore', () => ({
  useUIStore: (selector: (state: typeof fakeUi) => unknown) => selector(fakeUi),
}));
mock.module('@/components/ui', () => ({ toast: { error: () => undefined, warning: () => undefined, info: () => undefined } }));

const { ExtensionStatusPill, ExtensionStatusStrip, ExtensionWidgetCard, ExtensionWidgetStrip } = await import('./ExtensionStatusWidgets');

const PREFIX = 'PI_SUBAGENT_ASYNC_JSON:';
const GENERATED_AT = 1_700_000_300_000;

const snapshotLine = (overrides: Record<string, unknown> = {}) => `${PREFIX}${JSON.stringify({
  kind: 'pi-subagents.async-status-snapshot',
  version: 1,
  generatedAt: GENERATED_AT,
  caps: { maxRuns: 20, maxChildrenPerNode: 8, maxDepth: 3, maxStringLength: 160, maxSerializedBytes: 32768 },
  omitted: { runs: 0, children: 0, byteLimitExceeded: false },
  runs: [
    {
      id: 'run-a',
      kind: 'workflow',
      label: 'review-pipeline',
      state: 'running',
      startedAt: GENERATED_AT - 134_000,
      activity: { currentTool: 'bash', lastActivityAt: GENERATED_AT - 2_000 },
      children: [
        { id: 'run-a-1', kind: 'step', label: 'scout', state: 'complete', startedAt: GENERATED_AT - 134_000, endedAt: GENERATED_AT - 80_000 },
        {
          id: 'run-a-2',
          kind: 'step',
          label: 'reviewer',
          state: 'running',
          startedAt: GENERATED_AT - 70_000,
          children: [{ id: 'run-a-2-1', kind: 'subagent', label: 'nested-helper', state: 'failed', startedAt: GENERATED_AT - 60_000, endedAt: GENERATED_AT - 30_000 }],
        },
      ],
    },
    { id: 'run-b', kind: 'subagent', label: 'worker', state: 'queued' },
  ],
  ...overrides,
})}`;

const widgetEntry = (key: string, lines: string[]): [string, FakeWidget] => [key, { lines, placement: 'aboveEditor' }];
const noop = () => undefined;

const renderCard = (widgets: Array<[string, FakeWidget]>, collapsed = false, onCollapsedChange: (value: boolean) => void = noop) => renderToStaticMarkup(
  <ExtensionWidgetCard widgets={widgets} collapsed={collapsed} onCollapsedChange={onCollapsedChange} />,
);

type TreeNode = { type: unknown; props: Record<string, unknown> };

/** Expand function components until host elements remain, so a click handler can be found without a DOM. */
const findHostElement = (node: unknown, matches: (props: Record<string, unknown>) => boolean): TreeNode | null => {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findHostElement(child, matches);
      if (found) return found;
    }
    return null;
  }
  if (!React.isValidElement(node)) return null;
  const element = node as unknown as TreeNode;
  if (typeof element.type === 'string' && matches(element.props)) return element;
  if (typeof element.type === 'function') {
    try {
      return findHostElement((element.type as (props: unknown) => unknown)(element.props), matches);
    } catch {
      return null;
    }
  }
  return findHostElement(element.props.children, matches);
};

beforeEach(() => {
  fakeSession.extensionWidgets = new Map();
  fakeSession.extensionStatuses = new Map();
  fakeUi.extensionWidgetsCollapsed = false;
  fakeUi.extensionStatusCollapsed = false;
  collapseCalls.length = 0;
});

describe('ExtensionWidgetCard subagent-async widget', () => {
  test('renders one native row per run with nesting, tool, timing, and no raw text', () => {
    const markup = renderCard([widgetEntry('subagent-async', [snapshotLine()])]);
    expect(markup).not.toContain(PREFIX);
    expect(markup).not.toContain('pi-subagents.async-status-snapshot');
    for (const label of ['review-pipeline', 'scout', 'reviewer', 'nested-helper', 'worker']) expect(markup).toContain(label);
    expect(markup).toContain('bash');
    // Running: measured against generatedAt. Complete: start to end. Queued: no timing.
    expect(markup).toContain('2m 14s');
    expect(markup).toContain('54s');
    expect(markup).toContain('30s');
    // Children are indented by depth.
    expect(markup).toContain('padding-left:14px');
    expect(markup).toContain('padding-left:28px');
    // State indicators use status tokens.
    expect(markup).toContain('var(--status-info)');
    expect(markup).toContain('var(--status-success)');
    expect(markup).toContain('var(--status-error)');
    expect(markup).toContain('aria-label="failed"');
  });

  test('shows no timing for a queued node, even when it carries timestamps', () => {
    const queued = { id: 'q1', kind: 'subagent', label: 'waiting-helper', state: 'queued', updatedAt: GENERATED_AT - 1_000, activity: { lastActivityAt: GENERATED_AT - 1_000 } };
    const markup = renderCard([widgetEntry('subagent-async', [snapshotLine({ runs: [queued] })])]);
    expect(markup).toContain('waiting-helper');
    expect(markup).not.toContain('ago');
    expect(markup).not.toMatch(/\d+s/);
    // A non-queued node without a start time still shows its last activity.
    const idle = { id: 'p1', kind: 'subagent', label: 'paused-helper', state: 'paused', updatedAt: GENERATED_AT - 5_000 };
    expect(renderCard([widgetEntry('subagent-async', [snapshotLine({ runs: [idle] })])])).toContain('5s ago');
  });

  test('shows omitted runs and children as a count', () => {
    const markup = renderCard([widgetEntry('subagent-async', [snapshotLine({ omitted: { runs: 3, children: 1, byteLimitExceeded: false } })])]);
    expect(markup).toContain('3 more runs and 1 nested run not shown');
    const single = renderCard([widgetEntry('subagent-async', [snapshotLine({ omitted: { runs: 1, children: 2, byteLimitExceeded: true } })])]);
    expect(single).toContain('1 more run and 2 nested runs not shown');
  });

  test('shows one muted unavailable line and no raw text when parsing fails', () => {
    const valid = snapshotLine();
    for (const line of [valid.slice(0, 60), `${PREFIX}{oops`, snapshotLine({ version: 2 })]) {
      const markup = renderCard([widgetEntry('subagent-async', [line])]);
      expect(markup).toContain('Subagent status unavailable');
      expect(markup).not.toContain(PREFIX);
      expect(markup).not.toContain('oops');
    }
  });

  test('says so when there are no runs', () => {
    expect(renderCard([widgetEntry('subagent-async', [snapshotLine({ runs: [] })])])).toContain('No subagent runs');
  });
});

describe('ExtensionWidgetCard other widgets and hidden keys', () => {
  test('renders other widgets as text lines as before', () => {
    const markup = renderCard([widgetEntry('todo', ['[x] one', '[ ] two'])]);
    expect(markup).toContain('[x] one');
    expect(markup).toContain('[ ] two');
    expect(markup).toContain('font-mono');
  });

  test('never renders subagent-inspect', () => {
    const inspect = widgetEntry('subagent-inspect', ['PI_SUBAGENT_INSPECT_JSON:{"secret":"reply-body"}']);
    expect(renderCard([inspect])).toBe('');
    const mixed = renderCard([inspect, widgetEntry('todo', ['visible'])]);
    expect(mixed).toContain('visible');
    expect(mixed).not.toContain('reply-body');
    expect(mixed).not.toContain('PI_SUBAGENT_INSPECT_JSON');
  });

  test('the connected strip drops subagent-inspect and filters by placement', () => {
    fakeSession.extensionWidgets = new Map([
      ['subagent-inspect', { lines: ['PI_SUBAGENT_INSPECT_JSON:{"secret":"reply-body"}'], placement: 'aboveEditor' }],
      ['todo', { lines: ['above line'], placement: 'aboveEditor' }],
      ['footer', { lines: ['below line'], placement: 'belowEditor' }],
    ]);
    const above = renderToStaticMarkup(<ExtensionWidgetStrip sessionId="session-1" placement="aboveEditor" />);
    expect(above).toContain('above line');
    expect(above).not.toContain('below line');
    expect(above).not.toContain('reply-body');
    const below = renderToStaticMarkup(<ExtensionWidgetStrip sessionId="session-1" placement="belowEditor" />);
    expect(below).toContain('below line');
  });
});

describe('extension surface collapse', () => {
  test('the card header has a collapse button with aria state', () => {
    const markup = renderCard([widgetEntry('todo', ['first-line'])]);
    expect(markup).toContain('aria-label="Hide extension widgets"');
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('Extensions');
  });

  test('a collapsed card leaves one button with a count and hides the content', () => {
    const markup = renderCard([widgetEntry('todo', ['first-line']), widgetEntry('other', ['second-line'])], true);
    expect(markup).toContain('aria-label="Show extension widgets, 2 widgets"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('>Extensions<');
    expect(markup).toContain('>2<');
    expect(markup).not.toContain('first-line');
    expect(markup.match(/<button/g)).toHaveLength(1);
    expect(renderCard([widgetEntry('todo', ['first-line'])], true)).toContain('Show extension widgets, 1 widget"');
  });

  test('the collapse and expand buttons report the new state', () => {
    const calls: boolean[] = [];
    const widgets = [widgetEntry('todo', ['first-line'])];
    const hide = findHostElement(
      ExtensionWidgetCard({ widgets, collapsed: false, onCollapsedChange: (value) => calls.push(value) }),
      (props) => props['aria-label'] === 'Hide extension widgets',
    );
    (hide?.props.onClick as () => void)();
    const show = findHostElement(
      ExtensionWidgetCard({ widgets, collapsed: true, onCollapsedChange: (value) => calls.push(value) }),
      (props) => typeof props['aria-label'] === 'string' && (props['aria-label'] as string).startsWith('Show extension widgets'),
    );
    (show?.props.onClick as () => void)();
    expect(calls).toEqual([true, false]);
  });

  test('the status strip collapses to one button with a count and expands again', () => {
    const statuses: Array<[string, string]> = [['mode', 'fast-mode'], ['tokens', '12 t/s']];
    const expanded = renderToStaticMarkup(<ExtensionStatusPill statuses={statuses} collapsed={false} onCollapsedChange={noop} />);
    expect(expanded).toContain('aria-label="Hide extension status"');
    expect(expanded).toContain('aria-expanded="true"');
    expect(expanded).toContain('fast-mode');

    const collapsed = renderToStaticMarkup(<ExtensionStatusPill statuses={statuses} collapsed onCollapsedChange={noop} />);
    expect(collapsed).toContain('aria-label="Show extension status, 2 entries"');
    expect(collapsed).toContain('aria-expanded="false"');
    expect(collapsed).toContain('>Status<');
    expect(collapsed).not.toContain('fast-mode');
    expect(collapsed.match(/<button/g)).toHaveLength(1);
    expect(renderToStaticMarkup(<ExtensionStatusPill statuses={[]} collapsed onCollapsedChange={noop} />)).toBe('');
  });

  test('the connected strips follow the store fields and bind the matching setters', () => {
    fakeSession.extensionStatuses = new Map([['mode', 'fast-mode']]);
    fakeSession.extensionWidgets = new Map([['todo', { lines: ['first-line'], placement: 'aboveEditor' }]]);
    expect(renderToStaticMarkup(<ExtensionStatusStrip sessionId="session-1" />)).toContain('fast-mode');
    expect(renderToStaticMarkup(<ExtensionWidgetStrip sessionId="session-1" />)).toContain('first-line');

    fakeUi.extensionStatusCollapsed = true;
    expect(renderToStaticMarkup(<ExtensionStatusStrip sessionId="session-1" />)).not.toContain('fast-mode');
    expect(renderToStaticMarkup(<ExtensionWidgetStrip sessionId="session-1" />)).toContain('first-line');

    fakeUi.extensionWidgetsCollapsed = true;
    expect(renderToStaticMarkup(<ExtensionWidgetStrip sessionId="session-1" />)).not.toContain('first-line');

    const statusStrip = ExtensionStatusStrip({ sessionId: 'session-1' }) as unknown as { props: { onCollapsedChange: (value: boolean) => void } };
    statusStrip.props.onCollapsedChange(false);
    const widgetStrip = ExtensionWidgetStrip({ sessionId: 'session-1' }) as unknown as { props: { onCollapsedChange: (value: boolean) => void } };
    widgetStrip.props.onCollapsedChange(false);
    expect(collapseCalls).toEqual(['status:false', 'widgets:false']);
  });
});
