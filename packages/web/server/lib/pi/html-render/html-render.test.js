import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { registerPiRuntimeRoutes } from '../routes.js';
import { injectHtmlRenderBootstrap } from './bootstrap.js';
import { inlineLocalImages } from './images.js';
import {
  createHtmlRenderExtension,
  HTML_RENDER_RESULT_MESSAGE,
  HTML_RENDER_TOOL,
} from './pi-extension.js';
import { createHtmlRenderUrlSigner, isSignedHtmlRenderRequest } from './signed-url.js';
import { createHtmlRenderStore } from './store.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const CSP = 'sandbox allow-scripts allow-forms allow-popups allow-downloads';

let directory;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pichamber-html-render-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const registerTool = (store) => {
  let tool;
  createHtmlRenderExtension({ store }).factory({ registerTool: (definition) => { tool = definition; } });
  return tool;
};
const ctxFor = (sessionId) => ({ sessionManager: { getSessionId: () => sessionId } });

describe('html_render bootstrap', () => {
  it('puts the theme bootstrap first in the head, before the page styles', () => {
    const page = injectHtmlRenderBootstrap('<!doctype html><html><head><style>p{}</style></head><body><p>x</p></body></html>');
    const head = page.indexOf('<head>') + '<head>'.length;
    expect(page.indexOf('<style id="pichamber-theme">')).toBeGreaterThanOrEqual(head);
    expect(page.indexOf('<style id="pichamber-theme">')).toBeLessThan(page.indexOf('<style>p{}'));
    expect(page).toContain('ui/notifications/size-changed');
  });

  it('adds a head to fragments and ignores a <head> inside a comment or script', () => {
    expect(injectHtmlRenderBootstrap('<p>hi</p>')).toMatch(/^<!doctype html><head><meta charset="utf-8">.*<\/head><p>hi<\/p>$/s);
    const page = injectHtmlRenderBootstrap('<!-- <head> --><html><body><script>"<head>"</script></body></html>');
    expect(page.startsWith('<!-- <head> --><html><head><meta charset')).toBe(true);
  });
});

describe('html_render image inlining', () => {
  it('inlines absolute local images and reports unreadable or non-image files', async () => {
    const image = join(directory, 'shot.png');
    const secret = join(directory, 'secret.png');
    await writeFile(image, PNG);
    await writeFile(secret, 'TOKEN=not-an-image');
    const missing = join(directory, 'missing.png');
    const result = await inlineLocalImages(
      `<img src="${image}"><div style="background:url(${image})"></div><img src="${secret}"><img src="${missing}"><img src="https://example.com/a.png">`,
    );
    expect(result.html.match(/data:image\/png;base64,/g)).toHaveLength(2);
    expect(result.html).toContain('https://example.com/a.png');
    expect(result.html).not.toContain('TOKEN');
    expect(result.missing.sort()).toEqual([missing, secret].sort());
  });
});

describe('html_render store', () => {
  it('keeps pages per session and refuses traversal ids', async () => {
    const store = createHtmlRenderStore({ directory });
    const renderId = await store.save('session-1', '<p>a</p>');
    expect((await store.read('session-1', renderId)).toString()).toBe('<p>a</p>');
    expect(await store.read('session-2', renderId)).toBeNull();
    expect(await store.read('..', renderId)).toBeNull();
    expect(await store.read('session-1', '../session-1')).toBeNull();
    await expect(store.save('../x', 'y')).rejects.toThrow('invalid session id');
  });
});

describe('html_render URL signer', () => {
  it('accepts only its own unexpired signature for the same page', () => {
    let now = 1_000;
    const signer = createHtmlRenderUrlSigner({ ttlMs: 100, now: () => now });
    const { url, expiresAt } = signer.mint('s1', 'r1');
    expect(expiresAt).toBe(1_100);
    const query = new URL(url, 'http://x').searchParams;
    const expires = query.get('expires');
    const sig = query.get('sig');
    expect(signer.verify('s1', 'r1', expires, sig)).toBe(true);
    expect(signer.verify('s1', 'r2', expires, sig)).toBe(false);
    expect(signer.verify('s2', 'r1', expires, sig)).toBe(false);
    expect(signer.verify('s1', 'r1', String(Number(expires) + 1), sig)).toBe(false);
    expect(createHtmlRenderUrlSigner({ now: () => now }).verify('s1', 'r1', expires, sig)).toBe(false);
    now = 1_100;
    expect(signer.verify('s1', 'r1', expires, sig)).toBe(false);
  });

  it('lets only signed page GETs past the API auth gate', () => {
    const path = '/api/pi/html-renders/s1/r1';
    expect(isSignedHtmlRenderRequest(path, { method: 'GET', query: { sig: 'x' } })).toBe(true);
    expect(isSignedHtmlRenderRequest(path, { method: 'GET', query: {} })).toBe(false);
    expect(isSignedHtmlRenderRequest(path, { method: 'POST', query: { sig: 'x' } })).toBe(false);
    expect(isSignedHtmlRenderRequest('/api/pi/sessions/s1', { method: 'GET', query: { sig: 'x' } })).toBe(false);
  });
});

describe('html_render tool', () => {
  it('declares the t3code contract: a document and an optional title', () => {
    expect(HTML_RENDER_TOOL.name).toBe('html_render');
    expect(HTML_RENDER_TOOL.parameters).toMatchObject({
      required: ['html'],
      additionalProperties: false,
      properties: {
        html: { type: 'string', minLength: 1, maxLength: 512_000 },
        title: { type: 'string', maxLength: 200 },
      },
    });
  });

  it('stores the prepared page with the calling session and names it in the result', async () => {
    const store = createHtmlRenderStore({ directory });
    const tool = registerTool(store);
    const result = await tool.execute('call-1', { html: '<h1>Hi</h1>', title: '  Chart  ' }, undefined, undefined, ctxFor('session-1'));
    expect(result.content).toEqual([{ type: 'text', text: HTML_RENDER_RESULT_MESSAGE }]);
    expect(result.details.htmlRender.title).toBe('Chart');
    const page = (await store.read('session-1', result.details.htmlRender.renderId)).toString();
    expect(page).toContain('<style id="pichamber-theme">');
    expect(page).toContain('<h1>Hi</h1>');

    const untitled = await tool.execute('call-2', { html: '<p>x</p>' }, undefined, undefined, ctxFor('session-1'));
    expect(untitled.details.htmlRender.title).toBe('HTML');
  });

  it('fails with an actionable message when a local image is missing', async () => {
    const tool = registerTool(createHtmlRenderStore({ directory }));
    await expect(tool.execute('call-1', { html: '<img src="/nope/missing.png">' }, undefined, undefined, ctxFor('session-1')))
      .rejects.toThrow('/nope/missing.png');
  });
});

describe('html_render routes', () => {
  let server;
  afterEach(async () => {
    await new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  const start = async (signer = createHtmlRenderUrlSigner()) => {
    const store = createHtmlRenderStore({ directory });
    const app = express();
    registerPiRuntimeRoutes(app, { getPiSessionDaemonRuntime: () => ({}), htmlRenderStore: store, htmlRenderUrlSigner: signer });
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    return { store, base: `http://127.0.0.1:${server.address().port}` };
  };

  it('serves a stored page only through its signed URL, with the sandbox CSP', async () => {
    const { store, base } = await start();
    const renderId = await store.save('session-1', '<p>page</p>');
    const minted = await fetch(`${base}/api/pi/sessions/session-1/html-renders/${renderId}/url`, { method: 'POST' });
    expect(minted.status).toBe(200);
    const { url } = await minted.json();

    const page = await fetch(`${base}${url}`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toBe(CSP);
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(page.headers.get('cache-control')).toBe('private, no-store');
    expect(await page.text()).toBe('<p>page</p>');

    const unsigned = await fetch(`${base}/api/pi/html-renders/session-1/${renderId}`);
    expect(unsigned.status).toBe(403);
    const otherPage = await fetch(`${base}${url.replace(renderId, 'other')}`);
    expect(otherPage.status).toBe(403);
  });

  it('refuses expired links and pages that were never stored', async () => {
    let now = 0;
    const { store, base } = await start(createHtmlRenderUrlSigner({ ttlMs: 10, now: () => now }));
    const renderId = await store.save('session-1', '<p>page</p>');
    const { url } = await (await fetch(`${base}/api/pi/sessions/session-1/html-renders/${renderId}/url`, { method: 'POST' })).json();
    now = 10;
    expect((await fetch(`${base}${url}`)).status).toBe(403);

    const missing = await fetch(`${base}/api/pi/sessions/session-1/html-renders/missing/url`, { method: 'POST' });
    expect(missing.status).toBe(404);
  });
});
