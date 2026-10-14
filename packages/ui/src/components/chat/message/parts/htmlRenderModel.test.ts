import { describe, expect, test } from 'bun:test';

import type { Part } from '@/lib/chat/types';
import type { Theme } from '@/types/theme';
import {
  clampHtmlRenderHeight,
  htmlRenderTheme,
  htmlRenderThemeFragment,
  htmlRenderThemeMessage,
  readHtmlRenderContentHeight,
  readHtmlRenderLinkRequest,
  readHtmlRenderReference,
} from './htmlRenderModel';

const toolPart = (tool: string, status: string, metadata?: unknown) => ({
  id: 'p1',
  type: 'tool',
  tool,
  callID: 'c1',
  state: { status, input: {}, metadata, time: { start: 1 } },
}) as unknown as Part;

describe('readHtmlRenderReference', () => {
  test('reads the page a completed html_render call published', () => {
    expect(readHtmlRenderReference(toolPart('html_render', 'completed', { htmlRender: { renderId: 'abc-1', title: 'Chart' } })))
      .toEqual({ renderId: 'abc-1', title: 'Chart' });
    expect(readHtmlRenderReference(toolPart('html_render', 'completed', { htmlRender: { renderId: 'abc-1' } }))?.title).toBe('HTML');
  });

  test('ignores other tools, unfinished calls, and ids that could leave the session', () => {
    const reference = { htmlRender: { renderId: 'abc', title: 'x' } };
    expect(readHtmlRenderReference(toolPart('read', 'completed', reference))).toBeUndefined();
    expect(readHtmlRenderReference(toolPart('html_render', 'running', reference))).toBeUndefined();
    expect(readHtmlRenderReference(toolPart('html_render', 'error', reference))).toBeUndefined();
    expect(readHtmlRenderReference(toolPart('html_render', 'completed', { htmlRender: { renderId: '../x' } }))).toBeUndefined();
    expect(readHtmlRenderReference({ id: 't', type: 'text', text: 'hi' } as Part)).toBeUndefined();
  });
});

describe('page messages', () => {
  test('clamps reported heights to 80..2000 px', () => {
    expect(clampHtmlRenderHeight(10)).toBe(80);
    expect(clampHtmlRenderHeight(640.2)).toBe(641);
    expect(clampHtmlRenderHeight(9000)).toBe(2000);
  });

  test('reads only well-formed size and link requests', () => {
    expect(readHtmlRenderContentHeight({ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { height: 512 } })).toBe(512);
    expect(readHtmlRenderContentHeight({ method: 'ui/notifications/size-changed', params: { height: 512 } })).toBeUndefined();
    expect(readHtmlRenderContentHeight({ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { height: 'x' } })).toBeUndefined();

    const link = (url: string) => ({ jsonrpc: '2.0', id: 'l1', method: 'ui/open-link', params: { url, metaKey: true } });
    expect(readHtmlRenderLinkRequest(link('https://example.com/a'))).toEqual({ url: 'https://example.com/a', metaKey: true, ctrlKey: false });
    expect(readHtmlRenderLinkRequest(link('javascript:alert(1)'))).toBeUndefined();
    expect(readHtmlRenderLinkRequest(link('file:///etc/passwd'))).toBeUndefined();
  });
});

describe('htmlRenderTheme', () => {
  const theme = {
    metadata: { variant: 'light' },
    colors: {
      primary: { base: '#111111', foreground: '#ffffff' },
      surface: { background: '#fafafa', foreground: '#222222', muted: '#eeeeee', mutedForeground: '#666666', elevated: '#ffffff', elevatedForeground: '#222222', overlay: '#000000', subtle: '#f0f0f0' },
      interactive: { border: '#dddddd', focusRing: '#3355ff', selection: '#ccddff', selectionForeground: '#000000' },
      status: { error: '#ff0000', errorForeground: '#ffffff', errorBackground: '#ffeeee', warning: '#ffaa00', warningForeground: '#000000', warningBackground: '#fff5e0', success: '#00aa00', successForeground: '#ffffff', info: '#0088ff', infoForeground: '#ffffff' },
      syntax: { base: { background: '#f6f6f6', foreground: '#333333' } },
      charts: { series: ['#aa0000', '#00aa00'] },
    },
    config: { fonts: { sans: 'Inter' } },
  } as unknown as Theme;

  test('maps the app theme onto the variables the page guide documents', () => {
    const { appearance, variables } = htmlRenderTheme(theme);
    expect(appearance).toBe('light');
    expect(variables).toMatchObject({
      '--background': '#fafafa',
      '--foreground': '#222222',
      '--border': '#dddddd',
      '--primary': '#111111',
      '--destructive': '#ff0000',
      '--code-background': '#f6f6f6',
      '--chart-1': '#aa0000',
      '--chart-2': '#00aa00',
      '--font-sans': 'Inter',
    });
    expect(typeof variables['--chart-6']).toBe('string');
    expect(variables['--font-mono']).toContain('monospace');
  });

  test('passes the theme as a URL fragment and as a host-context message', () => {
    const pageTheme = htmlRenderTheme(theme);
    const fragment = htmlRenderThemeFragment(pageTheme);
    expect(fragment.startsWith('#pichamber-theme=')).toBe(true);
    expect(JSON.parse(decodeURIComponent(fragment.slice('#pichamber-theme='.length)))).toEqual(pageTheme);
    expect(htmlRenderThemeMessage(pageTheme)).toEqual({
      jsonrpc: '2.0',
      method: 'ui/notifications/host-context-changed',
      params: { theme: 'light', styles: { variables: pageTheme.variables } },
    });
  });
});
