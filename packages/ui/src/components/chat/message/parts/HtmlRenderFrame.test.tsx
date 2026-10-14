import { describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';

let relayActive = false;
let connection: 'loading' | 'ready' | 'unavailable' | 'error' = 'ready';
let mintFails = false;
let mintCalls = 0;

mock.module('@/contexts/useThemeSystem', () => ({
  useThemeSystem: () => ({ currentTheme: null }),
}));
const relayTunnel = await import('@/lib/relay/runtime-tunnel');
mock.module('@/lib/relay/runtime-tunnel', () => ({
  ...relayTunnel,
  getActiveRelayTunnel: () => (relayActive ? {} : null),
}));

const syncContext = await import('@/sync/sync-context');
mock.module('@/sync/sync-context', () => ({
  ...syncContext,
  usePiConnectionState: () => connection,
}));
const runtimeFetchModule = await import('@/lib/runtime-fetch');
mock.module('@/lib/runtime-fetch', () => ({
  ...runtimeFetchModule,
  runtimeFetch: async () => {
    mintCalls += 1;
    if (mintFails) throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify({ url: '/api/pi/html-renders/s1/r1?expires=1&sig=x' }));
  },
}));
const runtimeUrl = await import('@/lib/runtime-url');
mock.module('@/lib/runtime-url', () => ({
  ...runtimeUrl,
  getRuntimeUrlResolver: () => ({ api: (path: string) => `http://server${path}` }),
}));

const { HtmlRenderDocument } = await import('./HtmlRenderDocument');
const { HtmlRenderFrame } = await import('./HtmlRenderFrame');
const { useHtmlRenderSource } = await import('./useHtmlRenderSource');

// The hook renders nothing, so a document with an inert container is enough DOM for React.
const installMinimalDom = () => {
  const names = ['document', 'window', 'HTMLIFrameElement', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const saved = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  const documentStub: Record<string, unknown> = {
    nodeType: 9,
    defaultView: globalThis,
    activeElement: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  const container = {
    nodeType: 1,
    tagName: 'DIV',
    nodeName: 'DIV',
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    ownerDocument: documentStub,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  documentStub.body = container;
  documentStub.documentElement = container;
  const values = [documentStub, globalThis, class {}, true];
  names.forEach((name, index) => {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: values[index] });
  });
  return {
    container: container as unknown as Element,
    restore: () => names.forEach((name, index) => {
      const descriptor = saved[index];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }),
  };
};

describe('HtmlRenderDocument', () => {
  test('frames the page without same-origin access', () => {
    const markup = renderToStaticMarkup(
      <HtmlRenderDocument src="/api/pi/html-renders/s/r?expires=1&amp;sig=x" title="Chart" />,
    );
    expect(markup).toContain('sandbox="allow-scripts allow-forms"');
    expect(markup).not.toContain('allow-same-origin');
    expect(markup).toContain('title="Chart"');
  });
});

describe('HtmlRenderFrame', () => {
  const reference = { renderId: 'r1', title: 'Chart' };

  test('holds a fixed box while the page URL loads', () => {
    relayActive = false;
    const markup = renderToStaticMarkup(<HtmlRenderFrame sessionId="s1" reference={reference} />);
    expect(markup).toContain('height:320px');
    expect(markup).toContain('Loading Chart');
  });

  test('asks again for a page whose first request failed once the connection is back', async () => {
    relayActive = false;
    connection = 'error';
    mintFails = true;
    mintCalls = 0;
    let source: ReturnType<typeof useHtmlRenderSource> | undefined;
    const Probe = () => {
      source = useHtmlRenderSource('s1', 'r1');
      return null;
    };
    const dom = installMinimalDom();
    const root = createRoot(dom.container);
    try {
      await act(async () => root.render(<Probe />));
      expect(source).toEqual({ kind: 'failed' });
      expect(mintCalls).toBe(1);

      connection = 'ready';
      mintFails = false;
      await act(async () => root.render(<Probe />));
      expect(source).toEqual({ kind: 'ready', src: 'http://server/api/pi/html-renders/s1/r1?expires=1&sig=x' });
      expect(mintCalls).toBe(2);

      // A loaded page keeps its URL through later renders and reconnects.
      connection = 'error';
      await act(async () => root.render(<Probe />));
      connection = 'ready';
      await act(async () => root.render(<Probe />));
      expect(source?.kind).toBe('ready');
      expect(mintCalls).toBe(2);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  test('says why the page is missing over the private relay', () => {
    relayActive = true;
    const markup = renderToStaticMarkup(<HtmlRenderFrame sessionId="s1" reference={reference} />);
    expect(markup).toContain('can&#x27;t be shown over the private relay');
    expect(markup).not.toContain('<iframe');
  });
});
