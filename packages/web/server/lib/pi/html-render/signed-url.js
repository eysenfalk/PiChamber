import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// A sandboxed html_render frame cannot carry app credentials, and a page can
// read its own URL, so the URL is a capability for that one page only: an
// HMAC over session, render and expiry with a key that lives in this process.

const HTML_RENDER_PATH_PREFIX = '/api/pi/html-renders/';
const HTML_RENDER_URL_TTL_MS = 60 * 60 * 1000;

/** Whether a request asks for an html_render page with a signature; the route verifies it. */
export const isSignedHtmlRenderRequest = (pathname, req) => req?.method === 'GET'
  && typeof pathname === 'string'
  && pathname.startsWith(HTML_RENDER_PATH_PREFIX)
  && typeof req.query?.sig === 'string'
  && req.query.sig.length > 0;

export const createHtmlRenderUrlSigner = ({
  key = randomBytes(32),
  ttlMs = HTML_RENDER_URL_TTL_MS,
  now = () => Date.now(),
} = {}) => {
  const signature = (sessionId, renderId, expires) => createHmac('sha256', key)
    .update(`${sessionId}\n${renderId}\n${expires}`)
    .digest('base64url');

  return {
    mint(sessionId, renderId) {
      const expiresAt = now() + ttlMs;
      const query = new URLSearchParams({ expires: String(expiresAt), sig: signature(sessionId, renderId, expiresAt) });
      return {
        url: `${HTML_RENDER_PATH_PREFIX}${encodeURIComponent(sessionId)}/${encodeURIComponent(renderId)}?${query}`,
        expiresAt,
      };
    },
    verify(sessionId, renderId, expires, sig) {
      if (typeof expires !== 'string' || !/^\d{1,16}$/.test(expires) || typeof sig !== 'string') return false;
      const expiresAt = Number(expires);
      if (expiresAt <= now()) return false;
      const expected = Buffer.from(signature(sessionId, renderId, expiresAt));
      const actual = Buffer.from(sig);
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    },
  };
};
