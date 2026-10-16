// Wire protocol of the remote browser socket (`/api/browser/ws`).
//
// Client to server: JSON text messages, validated here before anything reaches
// the desktop host. Server to client: binary messages carry one JPEG frame,
// text messages carry `state`, `notice` or `error` JSON.

export const BROWSER_WS_PATH = '/api/browser/ws';
export const BROWSER_MAX_CLIENT_MESSAGE_BYTES = 16 * 1024;

const MAX_URL_LENGTH = 8192;
const MAX_TEXT_LENGTH = 2000;
const MIN_VIEWPORT = 100;
const MAX_VIEWPORT = 4096;
const MAX_COORDINATE = 16384;
const MAX_SCROLL_DELTA = 10000;

const BROWSER_KEYS = new Set([
  'Enter', 'Backspace', 'Tab', 'Escape', 'Delete',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown',
]);

const SIMPLE_TYPES = new Set(['back', 'forward', 'reload', 'stop', 'ack']);

const badMessage = (message) => Object.assign(new Error(message), { code: 'BAD_MESSAGE' });

export const parseRequestPathname = (url) => {
  try {
    return new URL(url || '/', 'http://localhost').pathname;
  } catch {
    return '';
  }
};

const readNumber = (value, min, max, name) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw badMessage(`${name} must be a number from ${min} to ${max}`);
  }
  return value;
};

const readUrl = (value) => {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_URL_LENGTH) throw badMessage('url is invalid');
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw badMessage('url is invalid');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw badMessage('url must use http or https');
  return parsed.toString();
};

/** Returns the normalized client message or throws an error with code BAD_MESSAGE. */
export const parseBrowserClientMessage = (raw) => {
  let value;
  try {
    value = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8'));
  } catch {
    throw badMessage('message is not JSON');
  }
  if (!value || typeof value !== 'object' || typeof value.type !== 'string') throw badMessage('message has no type');
  const { type } = value;
  if (SIMPLE_TYPES.has(type)) return { type };
  switch (type) {
    case 'navigate':
      return { type, url: readUrl(value.url) };
    case 'resize':
      return {
        type,
        width: Math.round(readNumber(value.width, MIN_VIEWPORT, MAX_VIEWPORT, 'width')),
        height: Math.round(readNumber(value.height, MIN_VIEWPORT, MAX_VIEWPORT, 'height')),
      };
    case 'tap':
      return {
        type,
        x: Math.round(readNumber(value.x, 0, MAX_COORDINATE, 'x')),
        y: Math.round(readNumber(value.y, 0, MAX_COORDINATE, 'y')),
      };
    case 'scroll':
      return {
        type,
        x: Math.round(readNumber(value.x, 0, MAX_COORDINATE, 'x')),
        y: Math.round(readNumber(value.y, 0, MAX_COORDINATE, 'y')),
        deltaX: Math.round(readNumber(value.deltaX ?? 0, -MAX_SCROLL_DELTA, MAX_SCROLL_DELTA, 'deltaX')),
        deltaY: Math.round(readNumber(value.deltaY ?? 0, -MAX_SCROLL_DELTA, MAX_SCROLL_DELTA, 'deltaY')),
      };
    case 'text':
      if (typeof value.text !== 'string' || !value.text || value.text.length > MAX_TEXT_LENGTH) throw badMessage('text is invalid');
      return { type, text: value.text };
    case 'key':
      if (!BROWSER_KEYS.has(value.key)) throw badMessage('key is not supported');
      return { type, key: value.key };
    default:
      throw badMessage('message type is not supported');
  }
};
