import { describe, expect, it } from 'vitest';

import { projectEventFrame, projectExtensionList } from './routes.js';

const frame = (event, payload, sequence = 1) => ({
  protocolVersion: 1,
  kind: 'event',
  event,
  sequence,
  payload: { sessionId: 'sess-1', directory: '/work', ...payload },
});

describe('extension public projections', () => {
  it('whitelists extension list fields and rejects path-shaped identities', () => {
    expect(projectExtensionList({
      directory: '/work',
      extensions: [{ id: '0123456789abcdef', name: 'economy', path: '/secret/economy.ts' }],
      commands: [{ name: 'balance', description: 'Switch mode', source: 'daemon-value', scope: 'global', path: '/secret' }],
    })).toEqual({
      directory: '/work',
      extensions: [{ id: '0123456789abcdef', name: 'economy' }],
      commands: [{ name: 'balance', description: 'Switch mode', source: 'extension', scope: 'global' }],
    });

    expect(() => projectExtensionList({
      directory: '/work',
      extensions: [{ id: '/secret/extension.ts', name: 'extension' }],
      commands: [],
    })).toThrow();
    expect(() => projectExtensionList({
      directory: '/work',
      extensions: [{ id: '0123456789abcdef', name: '../extension' }],
      commands: [],
    })).toThrow();
  });
  it('keeps a pi-subagents async status widget line whole and drops other oversized lines', () => {
    const snapshotLine = `PI_SUBAGENT_ASYNC_JSON:${'x'.repeat(20_000)}`;
    expect(projectEventFrame(frame('extension.widget', { key: 'subagent-async', lines: [snapshotLine] }))).toMatchObject({
      name: 'extension.widget',
      payload: { key: 'subagent-async', lines: [snapshotLine] },
    });
    expect(projectEventFrame(frame('extension.widget', { key: 'todo', lines: ['y'.repeat(2001)] }))).toBeNull();
    // The exception is for line 0 of subagent-async only.
    expect(projectEventFrame(frame('extension.widget', { key: 'other', lines: [snapshotLine] }))).toBeNull();
    expect(projectEventFrame(frame('extension.widget', { key: 'subagent-async', lines: ['first', snapshotLine] }))).toBeNull();
    const clamped = projectEventFrame(frame('extension.widget', { key: 'subagent-async', lines: [snapshotLine.slice(0, 100)] }));
    expect(clamped.payload.lines).toEqual([snapshotLine.slice(0, 100)]);

    const projected = projectEventFrame({
      ...frame('session.snapshot', {}),
      payload: {
        sessionId: 'sess-1',
        directory: '/work',
        extensionWidgets: [
          { key: 'subagent-async', lines: [snapshotLine] },
            { key: 'todo', lines: ['y'.repeat(2500)] },
            { key: 'other', lines: [snapshotLine] },
            { key: 'subagent-inspect', lines: ['first', snapshotLine] },
          ],
      },
    });
    const widgets = new Map(projected.payload.snapshot.extensionWidgets.map((widget) => [widget.key, widget.lines]));
    expect(widgets.get('subagent-async')).toEqual([snapshotLine]);
    expect(widgets.get('todo')).toEqual(['y'.repeat(2000)]);
    expect(widgets.get('other')).toEqual([snapshotLine.slice(0, 2000)]);
    expect(widgets.get('subagent-inspect')).toEqual(['first', snapshotLine.slice(0, 2000)]);
  });

  it('projects extension.ui panels with caps and removals', () => {
    const projected = projectEventFrame(frame('extension.ui', {
      id: 'subagents',
      title: 'Sub-agents',
      component: 'table',
      props: { columns: ['Agent'], rows: [['research']] },
      actions: [{ label: 'Clear', command: 'agents-clear' }],
    }));
    expect(projected).toMatchObject({
      name: 'extension.ui',
      payload: { id: 'subagents', title: 'Sub-agents', component: 'table' },
    });

    // Missing component and title is treated as an unregister.
    expect(projectEventFrame(frame('extension.ui', { id: 'gone' }))).toMatchObject({
      payload: { id: 'gone', removed: true },
    });

    // Invalid ids are dropped entirely.
    expect(projectEventFrame(frame('extension.ui', { id: '' }))).toBeNull();
    expect(projectEventFrame(frame('extension.ui', { id: `${'x'.repeat(200)}` }))).toBeNull();
  });

  it('projects extension.app payloads and rejects oversized html', () => {
    const projected = projectEventFrame(frame('extension.app', {
      appId: 'board',
      title: 'Board',
      html: '<button data-pichamber-command="run">Run</button>',
    }));
    expect(projected?.payload).toMatchObject({ appId: 'board', title: 'Board' });
    expect(projected?.payload.html).toContain('data-pichamber-command');

    expect(projectEventFrame(frame('extension.app', {
      appId: 'big',
      html: `${'<a>'.repeat(70_000)}`,
    }))).toBeNull();

    expect(projectEventFrame(frame('extension.app', { appId: 'gone', removed: true }))?.payload).toMatchObject({
      appId: 'gone',
      removed: true,
    });
  });

  it('projects bounded editor/title/catalog and tree invalidation events', () => {
    expect(projectEventFrame(frame('extension.editor', { text: 'draft' }))).toMatchObject({
      name: 'extension.editor', payload: { text: 'draft' },
    });
    expect(projectEventFrame(frame('extension.editor', { text: 'x'.repeat(100_001) }))).toBeNull();
    expect(projectEventFrame(frame('extension.title', { title: 'Mode\u0000 Picker' }))).toMatchObject({
      payload: { title: 'Mode  Picker' },
    });
    expect(projectEventFrame(frame('extension.title', {}))).toMatchObject({ payload: {} });
    expect(projectEventFrame(frame('extension.catalog', { providers: true, resources: true }))).toMatchObject({
      payload: { providers: true, resources: true },
    });
    expect(projectEventFrame(frame('extension.catalog', {}))).toBeNull();
    expect(projectEventFrame(frame('session.tree.updated', {}))).toMatchObject({ payload: {} });
  });

  it('projects form dialogs with sanitized fields', () => {
    const projected = projectEventFrame(frame('extension.dialog', {
      requestId: 'form-1',
      method: 'form',
      title: 'Spawn agent',
      fields: [
        { id: 'name', label: 'Name', type: 'text', required: true },
        { id: 'level', label: 'Level', type: 'select', options: ['low', 'high'], initial: 'high' },
        { id: 'bad' },
        null,
      ],
    }));
    expect(projected?.payload.method).toBe('form');
    expect(projected?.payload.fields).toHaveLength(2);
    expect(projected?.payload.fields[0]).toMatchObject({ id: 'name', type: 'text', required: true });
    expect(projected?.payload.fields[1]).toMatchObject({ id: 'level', initial: 'high', options: ['low', 'high'] });

    expect(projectEventFrame(frame('extension.dialog.dismiss', {
      requestId: 'form-1',
      reason: 'timeout',
    }))?.payload).toEqual({ requestId: 'form-1', reason: 'timeout' });
    expect(projectEventFrame(frame('extension.dialog.dismiss', {
      requestId: 'form-1',
      reason: 'invented',
    }))).toBeNull();

    // Unknown dialog methods fail closed: the frame is dropped.
    expect(projectEventFrame(frame('extension.dialog', {
      requestId: 'r1',
      method: 'hologram',
      title: '?',
    }))).toBeNull();
  });

  it('projects snapshot extensionPanels/extensionApps for reconnect', () => {
    const projected = projectEventFrame(frame('session.snapshot', {
      isStreaming: false,
      lifecycle: 'idle',
      queue: { steering: 0, followUp: 0 },
      lastSequence: 5,
      extensionStatuses: [{ key: 'mode', text: 'economy' }],
      extensionPanels: [{ id: 'panel-1', component: 'progress', props: { value: 50 } }],
      extensionApps: [{ appId: 'app-1', html: '<p>x</p>' }],
      extensionTitle: 'Build mode',
      extensionDialogs: [{
        requestId: 'form-1',
        method: 'form',
        title: 'Form',
        fields: [{ id: 'a', label: 'A', type: 'text' }],
      }],
    }));
    const snapshot = projected?.payload.snapshot;
    expect(snapshot.extensionPanels).toHaveLength(1);
    expect(snapshot.extensionApps).toHaveLength(1);
    expect(snapshot.extensionDialogs[0].fields).toHaveLength(1);
    expect(snapshot.extensionTitle).toBe('Build mode');
  });
});
