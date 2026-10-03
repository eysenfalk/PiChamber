import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture } from './tours.mjs';
import { tracksPageRequest, isStreamingResponse, createPageNetworkGate, recordTour, recordingUrl } from './record.mjs';

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


const checkout = { commit: 'a'.repeat(40), dirty: true };

function fakeRuntime({ failEvidence = false, failVideo = false, failFrame = false, controller } = {}) {
  let time = 100000, profile, closed = false, evidenceChecks = 0;
  const calls = [], handlers = new Map();
  const browser = { exitCode: 0, signalCode: null, kill: signal => calls.push(signal) };
  const client = {
    connect: async () => {}, on: (name, handler) => handlers.set(name, handler), close: () => { closed = true; },
    send: async (method, params = {}) => {
      calls.push(method);
      if (method === 'Page.startScreencast') handlers.get('Page.screencastFrame')({ data: failFrame ? null : 'ZnJhbWU=', metadata: { timestamp: time / 1000 }, sessionId: 1 });
      if (method === 'Page.captureScreenshot') { controller?.abort(new Error('Recording interrupted')); return { data: 'c2NyZWVuc2hvdA==' }; }
      if (method === 'Runtime.evaluate') {
        const expression = params.expression;
        if (expression.includes('classList')) throw new Error('Recorder must not apply theme classes');
        if (expression.includes('function checkEvidence')) {
          evidenceChecks++;
          return { result: { value: { ok: !failEvidence, results: [{ ok: !failEvidence, reason: failEvidence ? 'missing element' : '' }] } } };
        }
        if (expression.includes('function failurePageDetails')) return { result: { value: { url: 'http://localhost/mobile.html', errorBoundaryDetails: 'Error: synthetic failure' } } };
        if (expression.includes('function targetPoint')) return { result: { value: { x: 20, y: 20 } } };
        return { result: { value: true } };
      }
      return {};
    },
  };
  return {
    runtime: {
      now: () => time, wait: async ms => { time += ms; }, reservePort: async () => 9000,
      resolveChrome: () => '/fake/chrome', launchChrome: options => { profile = options.profileDir; calls.push('launch'); return browser; },
      createPageTarget: async () => ({ webSocketDebuggerUrl: 'ws://fake' }), createClient: () => client,
      execFileSync: (_, args, { cwd }) => { const file = args.at(-1); if (file === 'video.mp4' && failVideo) throw new Error('ffmpeg video failed'); writeFileSync(join(cwd, file), 'encoded bytes'); },
    },
    calls, profile: () => profile, closed: () => closed, evidenceChecks: () => evidenceChecks,
  };
}

test('record.mjs URL gate permits only loopback and the lab pod, including fixtures', async () => {
  for (const url of ['http://127.0.0.1:3111/', 'http://localhost:9999/', 'http://[::1]/', 'http://pichamber-lab:3000/']) expect(recordingUrl(url).protocol).toBe('http:');
  for (const url of ['https://example.com/', 'http://localhost.evil/', 'http://192.168.1.1/', 'http://user:token@localhost/', 'file:///tmp/index.html']) {
    const fake = fakeRuntime();
    await expect(recordTour(fixture, { url, checkout, runtime: fake.runtime })).rejects.toThrow('Recording requires');
    expect(fake.calls).toEqual([]);
  }
});

for (const kind of ['proven', 'evidence', 'video', 'frame', 'abort', 'pre-abort']) {
  test(`recordTour state machine: ${kind}, with fake CDP, clock, browser and encoder`, async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), 'proof-state-'));
    const controller = new AbortController();
    if (kind === 'pre-abort') controller.abort(new Error('Recording interrupted'));
    const fake = fakeRuntime({ failEvidence: kind === 'evidence', failVideo: kind === 'video', failFrame: kind === 'frame', controller: kind === 'abort' ? controller : undefined });
    const out = join(outputRoot, fixture.name);
    try {
      await mkdir(out);
      writeFileSync(join(out, 'report.json'), JSON.stringify({ status: 'proven' }));
      writeFileSync(join(out, '99.png'), 'stale proof');
      const run = recordTour(fixture, { url: 'http://localhost/', checkout, runtime: fake.runtime, outputRoot, signal: controller.signal });
      if (kind === 'proven') await run;
      else await expect(run).rejects.toThrow();
      const report = JSON.parse(await readFile(join(out, 'report.json'), 'utf8'));
      expect(report.checkout).toEqual(checkout);
      expect(report.status).toBe(kind === 'proven' ? 'proven' : 'not-proven');
      const files = await readdir(out);
      expect(files).not.toContain('99.png');
      if (kind === 'proven') {
        expect(fake.evidenceChecks()).toBe(9); // Eight step gates plus the action text wait.
        expect(files.sort()).toEqual(['01.png', '02.png', '03.png', '04.png', 'contact-sheet.png', 'index.md', 'report.json', 'video.mp4']);
        expect(await readFile(join(out, 'index.md'), 'utf8')).toContain('Checkout: `' + checkout.commit + '`; dirty: true');
      } else {
        const sidecar = JSON.parse(await readFile(join(out, report.diagnosticFile), 'utf8'));
        expect(sidecar).toEqual(report.diagnostics);
        expect(files).toContain('raw');
        if (kind === 'evidence') {
          expect(report.phase).toBe('step'); expect(report.step).toBe(1);
          expect(files).toContain('01-not-proven.png');
          expect(fake.evidenceChecks()).toBe(1);
        }
        if (kind === 'video') {
          expect(report.phase).toBe('video'); expect(report.step).toBeUndefined();
          expect(report.diagnosticFile).toBe('video-not-proven.json');
          expect(files.some(file => file.endsWith('not-proven.png'))).toBe(false);
          expect(fake.calls.filter(method => method === 'Page.captureScreenshot')).toHaveLength(4);
        }
        if (kind === 'frame') expect(report.phase).toBe('screencast');
        if (kind === 'abort' || kind === 'pre-abort') {
          expect(report.error).toContain('Recording interrupted');
          expect(report.diagnostics.captureError).toContain('Recording interrupted');
          expect(files.some(file => file.endsWith('not-proven.png'))).toBe(false);
        }
      }
      if (kind === 'pre-abort') expect(fake.calls).toEqual([]);
      else {
        expect(fake.closed()).toBe(true);
        expect(fake.calls).toContain('Browser.close');
        expect(fake.calls).toContain('SIGTERM');
        await expect(stat(fake.profile())).rejects.toThrow();
      }
    } finally { await rm(outputRoot, { recursive: true, force: true }); }
  });
}
