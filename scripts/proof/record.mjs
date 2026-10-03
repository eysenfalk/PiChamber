import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { CdpClient, createPageTarget, launchChrome, reservePort, resolveChrome, wait } from '../perf/cdp.mjs';
import { evidenceExpression } from './visibility.mjs';
import { fixture, brokenFixture, labTour, validateTour, VIEWPORTS } from './tours.mjs';
import { planFiles, captionArgs, videoArgs, contactSheetArgs, frameTimeline, proofIndex, wrapCaption } from './media.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const usage = 'node scripts/proof/record.mjs <fixture|fixture-broken|lab> [--url URL] [--chrome PATH] [--ffmpeg PATH] [--manifest PATH]';
const idleProbe = 'window.__proofLastMutation = performance.now(); new MutationObserver(() => { window.__proofLastMutation = performance.now(); }).observe(document, {subtree:true, childList:true, attributes:true, characterData:true});';

// CDP defines an empty loaderId as a request fetched from a worker. Its finish
// events belong to the worker target, not this page's network/DOM idle gate.
export const tracksPageRequest = event => event.loaderId !== '' && !['WebSocket', 'EventSource'].includes(event.type);
export const isStreamingResponse = event => event.type === 'EventSource' || event.response?.mimeType === 'text/event-stream';

export function createPageNetworkGate(now = Date.now) {
  const pending = new Map();
  let changed = now();
  const finished = event => { if (pending.delete(event.requestId)) changed = now(); };
  return {
    quiet: () => pending.size === 0 && now() - changed >= 500,
    handlers: {
      'Network.requestWillBeSent': event => {
        if (tracksPageRequest(event)) { pending.set(event.requestId, event.loaderId); changed = now(); }
      },
      'Network.loadingFinished': finished,
      'Network.loadingFailed': finished,
      'Network.responseReceived': event => { if (isStreamingResponse(event)) finished(event); },
      // A committed main frame replaces old fetches whose cancellation events
      // may never reach this target. Keep the new document's pending requests.
      'Page.frameNavigated': event => {
        if (event.frame.parentId) return;
        for (const [id, loader] of pending) if (loader !== event.frame.loaderId) pending.delete(id);
        changed = now();
      },
    },
  };
}

/** A visible literal target, matching the smallest element that contains it. */
function targetPoint(target) {
  const normalize = text => text.replace(/\s+/g, ' ').trim();
  const elements = target.selector ? [...document.querySelectorAll(target.selector)] : [...document.querySelectorAll('body *')]
    .filter(element => normalize(element.textContent) === normalize(target.text) && ![...element.children].some(child => normalize(child.textContent) === normalize(target.text)));
  for (const element of elements) {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (box.width > 0 && box.height > 0 && box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight &&
        style.visibility === 'visible' && style.display !== 'none') {
      const x = box.left + box.width / 2, y = box.top + box.height / 2;
      const top = document.elementFromPoint(x, y);
      if (top && (element.contains(top) || top.contains(element))) return { x, y };
    }
  }
  throw new Error('Action target is missing, offscreen or covered');
}

export async function recordTour(tour, { url, chrome, ffmpeg = 'ffmpeg', outputRoot = join(root, '.proof'), holdMs = 1200, signal } = {}) {
  validateTour(tour);
  const targetUrl = new URL(url);
  if (!['http:', 'https:'].includes(targetUrl.protocol) || targetUrl.username || targetUrl.password) throw new Error('Target must be an HTTP URL without credentials');
  const out = join(outputRoot, tour.name);
  const files = planFiles(tour);
  // Remove the previous run, including success markers: a failed retry is never publishable.
  await rm(out, { recursive: true, force: true });
  await mkdir(join(out, 'raw/frames'), { recursive: true });
  const profileDir = await mkdtemp(join(tmpdir(), 'pichamber-proof-chrome-'));
  let browser, client, frameError, current = 0;
  const frames = [];
  const network = createPageNetworkGate();
  let capturing = false;
  const send = async (method, params = {}) => {
    signal?.throwIfAborted();
    let timer;
    try { return await Promise.race([client.send(method, params), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('CDP timeout: ' + method)), 15000); })]); }
    finally { clearTimeout(timer); }
  };
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  };
  const until = async (predicate, label) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      if (await predicate()) return;
      await wait(100);
    }
    throw new Error('Timed out: ' + label);
  };
  const idle = async () => {
    await evaluate('document.fonts.ready.then(() => true)');
    await until(async () => network.quiet() &&
      await evaluate('document.readyState === "complete" && performance.now() - (window.__proofLastMutation || 0) >= 500'), 'page idle (500ms DOM and finite network quiet)');
  };
  const viewport = async name => {
    const size = VIEWPORTS[name];
    await send('Emulation.setDeviceMetricsOverride', { ...size, screenWidth: size.width, screenHeight: size.height, deviceScaleFactor: 1 });
    await send('Emulation.setTouchEmulationEnabled', { enabled: size.mobile, maxTouchPoints: size.mobile ? 5 : 1 });
  };
  const theme = async mode => {
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: mode }] });
    await evaluate('(() => { localStorage.setItem("themeMode", ' + JSON.stringify(mode) + '); window.dispatchEvent(new StorageEvent("storage", {key:"themeMode", storageArea:localStorage})); document.documentElement.classList.toggle("dark", ' + JSON.stringify(mode === 'dark') + '); })()');
  };
  const screenshot = async file => {
    const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(join(out, file), Buffer.from(data, 'base64'));
  };
  const writeCaption = async (file, caption) => {
    await writeFile(join(out, file.text), caption);
    for (const [index, line] of caption.split('\n').entries()) await writeFile(join(out, file.text.replace('.txt', '-' + (index + 1) + '.txt')), line);
  };
  const runFfmpeg = args => execFileSync(ffmpeg, args, { cwd: out, stdio: ['ignore', 'ignore', 'pipe'], timeout: 120000 });
  try {
    const port = await reservePort();
    browser = launchChrome({ chrome: resolveChrome(chrome), profileDir, port, headless: true });
    const target = await createPageTarget(port);
    client = new CdpClient(target.webSocketDebuggerUrl);
    await client.connect();
    await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', { source: idleProbe });
    for (const [name, handler] of Object.entries(network.handlers)) client.on(name, handler);
    await viewport(tour.steps[0].viewport);
    // Give about:blank the target origin before applying storage-backed theme.
    const navigation = await send('Page.navigate', { url: targetUrl.href });
    if (navigation.errorText) throw new Error(navigation.errorText);
    await idle();
    client.on('Page.screencastFrame', event => {
      if (!capturing) return;
      try {
        const file = 'frames/' + String(frames.length + 1).padStart(6, '0') + '.jpg';
        writeFileSync(join(out, 'raw', file), Buffer.from(event.data, 'base64'));
        frames.push({ file, timestamp: event.metadata.timestamp });
      } catch (error) { frameError = error; }
      send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(error => { frameError = error; });
    });
    capturing = true;
    await send('Page.startScreencast', { format: 'jpeg', quality: 85, everyNthFrame: 1 });
    for (const [index, step] of tour.steps.entries()) {
      current = index;
      await viewport(step.viewport); await theme(step.theme);
      for (const action of step.actions) {
        if (action.type === 'navigate') {
          const destination = new URL(action.path, targetUrl);
          if (destination.origin !== targetUrl.origin) throw new Error('Navigation must stay on the target origin');
          const result = await send('Page.navigate', { url: destination.href });
          if (result.errorText) throw new Error(result.errorText);
          await idle(); await theme(step.theme);
        } else if (action.type === 'set-theme') await theme(action.theme);
        else if (action.type === 'set-viewport') await viewport(action.viewport);
        else if (action.type === 'wait') {
          if (action.ms !== undefined) await wait(action.ms);
          else await until(async () => action.selector ? await evaluate('!!document.querySelector(' + JSON.stringify(action.selector) + ')') :
            (await evaluate(evidenceExpression([{ text: action.text }]))).ok, 'wait target');
        } else if (action.type === 'click' || action.type === 'type') {
          const point = await evaluate('(' + targetPoint.toString() + ')(' + JSON.stringify(action) + ')');
          await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
          await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
          if (action.type === 'type') {
            await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2 });
            await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2 });
            await send('Input.insertText', { text: action.value });
          }
        } else if (action.type === 'scroll') await evaluate('(() => { const element = document.querySelector(' + JSON.stringify(action.selector) + '); if (!element) throw new Error("Missing scroll target"); ' +
          (action.x === undefined && action.y === undefined ? 'element.scrollIntoView({block:"center", inline:"nearest"});' : 'element.scrollTo(' + JSON.stringify({ left: action.x ?? 0, top: action.y ?? 0, behavior: 'instant' }) + ');') + ' })()');
      }
      await idle();
      const evidence = await evaluate(evidenceExpression(step.evidence));
      if (!evidence.ok) throw new Error('NOT PROVEN: ' + JSON.stringify(evidence.results));
      await wait(holdMs); await idle();
      const finalEvidence = await evaluate(evidenceExpression(step.evidence));
      if (!finalEvidence.ok) throw new Error('NOT PROVEN: ' + JSON.stringify(finalEvidence.results));
      await screenshot(files[index].raw);
      await writeCaption(files[index], files[index].caption);
      runFfmpeg(captionArgs(files[index]));
    }
    await send('Page.stopScreencast'); capturing = false;
    if (frameError) throw frameError;
    const endedAt = Date.now() / 1000;
    await writeFile(join(out, 'raw/frames.ffconcat'), frameTimeline(frames, endedAt));
    runFfmpeg(videoArgs()); runFfmpeg(contactSheetArgs(files));
    await writeFile(join(out, 'index.md'), proofIndex(tour, files));
    await writeFile(join(out, 'report.json'), JSON.stringify({ status: 'proven', tour: tour.name, steps: tour.steps.map((step, index) => ({ caption: step.caption, image: files[index].image, viewport: step.viewport, theme: step.theme, evidence: step.evidence })), selectorsVerified: true }, null, 2) + '\n');
    await rm(join(out, 'raw'), { recursive: true, force: true });
    return out;
  } catch (error) {
    if (client && !signal?.aborted) {
      try {
        const file = files[current];
        await screenshot(file.raw);
        const caption = wrapCaption('NOT PROVEN: ' + tour.steps[current].caption, file.width);
        await writeCaption(file, caption);
        runFfmpeg(captionArgs({ ...file, caption, band: caption.split('\n').length * 28 + 32 }, true));
      } catch { /* Preserve the original error; fallback raw screenshot if ffmpeg failed. */
        try { await writeFile(join(out, files[current].failure), await readFile(join(out, files[current].raw))); } catch { /* No page was available. */ }
      }
    }
    await writeFile(join(out, 'report.json'), JSON.stringify({ status: 'not-proven', tour: tour.name, step: current + 1, error: error.message }, null, 2) + '\n');
    throw error;
  } finally {
    capturing = false;
    if (client) {
      try { await Promise.race([client.send('Browser.close'), wait(2000)]); } catch { /* Browser may already be closed. */ }
      client.close();
    }
    if (browser) {
      browser.kill('SIGTERM');
      await Promise.race([new Promise(done => { if (browser.exitCode !== null || browser.signalCode !== null) done(); else browser.once('exit', done); }), wait(2000)]);
      if (browser.exitCode === null && browser.signalCode === null) browser.kill('SIGKILL');
    }
    await rm(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    url: { type: 'string' }, chrome: { type: 'string' }, ffmpeg: { type: 'string' }, manifest: { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) { console.log(usage); return; }
  const [name] = positionals;
  if (positionals.length !== 1 || !['fixture', 'fixture-broken', 'lab'].includes(name)) throw new Error('Choose fixture, fixture-broken or lab; see --help');
  const tour = name === 'lab' ? labTour(JSON.parse(await readFile(resolve(values.manifest || join(root, 'lab/seed-manifest.json')), 'utf8'))) : name === 'fixture' ? fixture : brokenFixture;
  let server;
  let url = values.url || process.env.PROOF_URL;
  const controller = new AbortController();
  const abort = () => controller.abort(new Error('Recording interrupted'));
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try {
    if (!url && name !== 'lab') {
      const html = await readFile(new URL('fixtures/index.html', import.meta.url));
      server = createServer((request, response) => { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(html); });
      await new Promise(done => server.listen(0, '127.0.0.1', done));
      url = 'http://127.0.0.1:' + server.address().port + '/';
    }
    if (!url) throw new Error('The lab requires --url or PROOF_URL');
    const out = await recordTour(tour, { url, chrome: values.chrome || process.env.PROOF_CHROME, ffmpeg: values.ffmpeg || process.env.PROOF_FFMPEG || 'ffmpeg', signal: controller.signal });
    console.log('Recorded ' + out);
  } finally {
    process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
    if (server) await new Promise(done => server.close(done));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.code?.startsWith('ERR_PARSE_ARGS') ? 'Usage: ' + usage + ' (' + error.message.replace(/\s+/g, ' ') + ')' : error.message); process.exitCode = 1; });
