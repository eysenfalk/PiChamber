import { expect, test } from 'bun:test';
import { tracksPageRequest, isStreamingResponse, createPageNetworkGate } from './record.mjs';

test('record.mjs page idle tracks finite page requests, not worker-owned or live channels', () => {
  expect(tracksPageRequest({ type: 'Fetch', loaderId: 'page' })).toBe(true);
  expect(tracksPageRequest({ type: 'Script', loaderId: 'page' })).toBe(true);
  expect(tracksPageRequest({ type: 'Script', loaderId: '' })).toBe(false);
  expect(tracksPageRequest({ type: 'WebSocket', loaderId: 'page' })).toBe(false);
  expect(tracksPageRequest({ type: 'EventSource', loaderId: 'page' })).toBe(false);
  expect(isStreamingResponse({ type: 'Fetch', response: { mimeType: 'text/event-stream' } })).toBe(true);
  expect(isStreamingResponse({ type: 'EventSource' })).toBe(true);
  expect(isStreamingResponse({ type: 'Fetch', response: { mimeType: 'application/json' } })).toBe(false);
});

test('record.mjs idle drops only the replaced document and keeps new finite fetches', () => {
  let time = 0;
  const gate = createPageNetworkGate(() => time);
  const event = (name, args) => gate.handlers[name](args);
  event('Network.requestWillBeSent', { requestId: 'old', type: 'Fetch', loaderId: 'old-page' });
  event('Network.requestWillBeSent', { requestId: 'new', type: 'Document', loaderId: 'new-page' });
  event('Page.frameNavigated', { frame: { loaderId: 'new-page' } });
  time = 501;
  expect(gate.quiet()).toBe(false);
  event('Network.loadingFinished', { requestId: 'new' });
  time = 1002;
  expect(gate.quiet()).toBe(true);
  event('Network.requestWillBeSent', { requestId: 'fetch', type: 'Fetch', loaderId: 'new-page' });
  event('Page.frameNavigated', { frame: { loaderId: 'child', parentId: 'main' } });
  time = 1503;
  expect(gate.quiet()).toBe(false);
  event('Network.loadingFailed', { requestId: 'fetch' });
  time = 2004;
  expect(gate.quiet()).toBe(true);
  event('Network.requestWillBeSent', { requestId: 'sse', type: 'Fetch', loaderId: 'new-page' });
  event('Network.responseReceived', { requestId: 'sse', type: 'Fetch', response: { mimeType: 'text/event-stream' } });
  time = 2505;
  expect(gate.quiet()).toBe(true);
  event('Network.loadingFinished', { requestId: 'untracked-worker' });
  expect(gate.quiet()).toBe(true);
});
