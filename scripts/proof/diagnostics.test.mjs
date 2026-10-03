import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { createPageDiagnostics, diagnosticText, diagnosticUrl, failurePageDetails, captureFailureDiagnostics, writeFailureReport } from './diagnostics.mjs';

const url = 'http://user:password@lab/mobile.html?token=private#access_token=hidden';
const stackTrace = { callFrames: [{ functionName: 'MobileView', url, lineNumber: 3, columnNumber: 5 }] };

test('diagnostics.mjs collects all three page error channels with stacks, not unrelated logs or object contents', () => {
  const collector = createPageDiagnostics();
  collector.handlers['Runtime.exceptionThrown']({ exceptionDetails: { text: 'Uncaught', exception: { description: 'Error: crash' }, stackTrace } });
  collector.handlers['Log.entryAdded']({ entry: { level: 'error', text: 'failed request', url, stackTrace } });
  collector.handlers['Runtime.consoleAPICalled']({ type: 'error', args: [{ type: 'string', value: 'Error caught by boundary:' }, { type: 'object', subtype: 'error', description: 'Error: crash' }, { type: 'object', description: 'token=private' }], stackTrace });
  collector.handlers['Log.entryAdded']({ entry: { level: 'info', text: 'not an error' } });
  collector.handlers['Runtime.consoleAPICalled']({ type: 'log', args: [] });
  const snapshot = collector.snapshot({ url, errorBoundaryDetails: 'Error: crash\nComponent stack: MobileView' });
  expect(snapshot.url).toBe('http://lab/mobile.html');
  expect(snapshot.events.map(event => event.source)).toEqual(['Runtime.exceptionThrown', 'Log.entryAdded', 'console.error']);
  for (const event of snapshot.events) expect(event.text).toContain('MobileView at http://lab/mobile.html:4:6');
  expect(snapshot.events[2].text).toContain('[object omitted]');
  expect(JSON.stringify(snapshot)).not.toContain('private');
  expect(snapshot.errorBoundaryDetails).toContain('Component stack');
});

test('diagnostics.mjs bounds recent errors and boundary text, and redacts credential carriers before truncation', () => {
  const collector = createPageDiagnostics();
  for (let i = 0; i < 55; i++) collector.handlers['Log.entryAdded']({ entry: { level: 'error', text: i + ' ' + 'long error '.repeat(1000) } });
  const snapshot = collector.snapshot({ url, errorBoundaryDetails: 'boundary '.repeat(2000) });
  expect(snapshot.events).toHaveLength(50);
  expect(snapshot.omittedEvents).toBe(5);
  expect(snapshot.events[0].text.startsWith('5 ')).toBe(true);
  expect(snapshot.events.every(event => event.text.length <= 4096)).toBe(true);
  expect(snapshot.errorBoundaryDetails).toHaveLength(8192);
  const text = diagnosticText(url + '\nBearer bearer-secret\n{"access_token":"short-secret", "password": "pw"}\napi_key=key-value cookie=session\n' + 'A'.repeat(80));
  for (const secret of ['user', 'password@', 'private', 'hidden', 'bearer-secret', 'short-secret', 'pw', 'key-value', 'session', 'A'.repeat(80)]) expect(text).not.toContain(secret);
  expect(text).toContain('[redacted]');
  expect(diagnosticUrl('data:text/html,private')).toBe('data:');
  expect(diagnosticUrl('bad URL')).toBe('[unavailable]');
  expect(diagnosticUrl('http://lab/' + 'A'.repeat(80))).toBe('http://lab/[redacted]');
  expect(diagnosticUrl('http://lab/' + 'path/'.repeat(1000)).length).toBe(2048);
  expect(diagnosticText('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJsYWIifQ.signature')).toBe('[redacted]');
});

test('diagnostics.mjs reads only error boundary pre text even with closed details, without changing the page', async () => {
  const detail = (summary, pre) => ({ querySelector: selector => ({ textContent: selector === 'summary' ? summary : pre }) });
  const evaluate = async expression => runInNewContext(expression, { document: { querySelectorAll: () => [detail('Other details', 'private page text'), detail('Error details', 'Error: crash\nComponent stack: MobileView')] }, location: { href: url } });
  const snapshot = await captureFailureDiagnostics(createPageDiagnostics(), evaluate, url);
  expect(snapshot.errorBoundaryDetails).toBe('Error: crash\nComponent stack: MobileView');
  expect(snapshot.url).toBe('http://lab/mobile.html');
  expect(failurePageDetails.toString()).not.toContain('.click(');
  const empty = await captureFailureDiagnostics(createPageDiagnostics(), async expression => runInNewContext(expression, { document: { querySelectorAll: () => [] }, location: { href: url } }), url);
  expect(empty.errorBoundaryDetails).toBe('');
});

test('diagnostics.mjs preserves failure and available events if evaluation fails, writing the same diagnostics beside the screenshot and in report', async () => {
  const collector = createPageDiagnostics();
  collector.handlers['Log.entryAdded']({ entry: { level: 'error', text: 'failed' } });
  const snapshot = await captureFailureDiagnostics(collector, async () => { throw new Error('Disconnected token=private'); }, url);
  expect(snapshot.captureError).toBe('Disconnected token=[redacted]');
  expect(snapshot.events).toHaveLength(1);
  const out = await mkdtemp(join(tmpdir(), 'proof-diagnostics-'));
  try {
    await writeFailureReport(out, { status: 'not-proven', step: 4, error: 'Timed out: wait target token=private' }, snapshot);
    const report = JSON.parse(await readFile(join(out, 'report.json'), 'utf8'));
    const sidecar = JSON.parse(await readFile(join(out, '04-not-proven.json'), 'utf8'));
    expect(report.status).toBe('not-proven');
    expect(report.diagnosticFile).toBe('04-not-proven.json');
    expect(report.diagnostics).toEqual(sidecar);
    expect(report.diagnostics).toEqual(snapshot);
    expect(JSON.stringify(report)).not.toContain('private');
  } finally { await rm(out, { recursive: true, force: true }); }
});
