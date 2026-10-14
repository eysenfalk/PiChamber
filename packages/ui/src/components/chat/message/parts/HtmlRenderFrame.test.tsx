import { describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

let relayActive = false;

mock.module('@/contexts/useThemeSystem', () => ({
  useThemeSystem: () => ({ currentTheme: null }),
}));
const relayTunnel = await import('@/lib/relay/runtime-tunnel');
mock.module('@/lib/relay/runtime-tunnel', () => ({
  ...relayTunnel,
  getActiveRelayTunnel: () => (relayActive ? {} : null),
}));

const { HtmlRenderDocument } = await import('./HtmlRenderDocument');
const { HtmlRenderFrame } = await import('./HtmlRenderFrame');

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

  test('says why the page is missing over the private relay', () => {
    relayActive = true;
    const markup = renderToStaticMarkup(<HtmlRenderFrame sessionId="s1" reference={reference} />);
    expect(markup).toContain('can&#x27;t be shown over the private relay');
    expect(markup).not.toContain('<iframe');
  });
});
