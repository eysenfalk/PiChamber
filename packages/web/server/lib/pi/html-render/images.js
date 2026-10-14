import { open, stat } from 'node:fs/promises';

// Ported from t3code `apps/server/src/htmlRender/HtmlRender.ts` (acb90279):
// a page may name local images by absolute path; they are inlined as data URIs
// so the stored page is self-contained and never reaches back into the disk.

const MIB = 1024 * 1024;
const HTML_RENDER_MAX_IMAGE_BYTES = 10 * MIB;
export const HTML_RENDER_MAX_PAGE_BYTES = 25 * MIB;
const formatMib = (bytes) => `${(bytes / MIB).toFixed(1)} MiB`;

/** A page the agent can fix; the message tells it how. */
class HtmlRenderRequestError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HtmlRenderRequestError';
    this.code = code;
  }
}

export const imagesNotFoundError = (paths) => new HtmlRenderRequestError(
  'HTML_RENDER_IMAGES_NOT_FOUND',
  `These local images could not be read: ${paths.join(', ')}. Use absolute paths to existing image files, or remove them.`,
);

const imageTooLargeError = (path, sizeBytes) => new HtmlRenderRequestError(
  'HTML_RENDER_IMAGE_TOO_LARGE',
  `${path} is ${formatMib(sizeBytes)}; each local image must be at most ${formatMib(HTML_RENDER_MAX_IMAGE_BYTES)}.`,
);

export const pageTooLargeError = (sizeBytes) => new HtmlRenderRequestError(
  'HTML_RENDER_PAGE_TOO_LARGE',
  `With its images inlined the page is ${formatMib(sizeBytes)}; the limit is ${formatMib(HTML_RENDER_MAX_PAGE_BYTES)}. Use smaller images.`,
);

const IMAGE_MIME_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
};
const IMAGE_EXTENSIONS = Object.keys(IMAGE_MIME_TYPES).join('|');
// POSIX `/…` (not protocol-relative `//…`) or Windows `C:\…` / `C:/…`.
const ABSOLUTE_PATH = String.raw`(?:/(?!/)|[a-z]:[\\/])`;
// An absolute image path that is a whole quoted string ("…", '…', `…`) or an
// unquoted CSS url(…). URLs, data:, blob:, and relative paths never match.
const LOCAL_IMAGE_PATTERN = new RegExp(
  String.raw`(["'\x60])(${ABSOLUTE_PATH}(?:(?!\1)[^\r\n]){0,2048}?\.(?:${IMAGE_EXTENSIONS}))\1`
    + String.raw`|url\(\s*(${ABSOLUTE_PATH}[^\s"'\x60()]{0,2048}?\.(?:${IMAGE_EXTENSIONS}))\s*\)`,
  'gid',
);

const findLocalImages = (html) => Array.from(html.matchAll(LOCAL_IMAGE_PATTERN)).flatMap((match) => {
  const span = match.indices?.[2] ?? match.indices?.[3];
  return span ? [{ start: span[0], end: span[1], path: html.slice(span[0], span[1]) }] : [];
});

// Inside a JS string literal a Windows path's backslashes are escaped.
const filePathFor = (reference) => (/^[a-z]:/i.test(reference) ? reference.replaceAll('\\\\', '\\') : reference);

const dataUriPrefix = (path) => `data:${IMAGE_MIME_TYPES[path.slice(path.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream'};base64,`;

const latin1 = (bytes, start, end) => String.fromCharCode(...bytes.subarray(start, end));

/** The index just past `token` at or after `from`, or -1 when it never appears. */
const after = (text, token, from) => {
  const at = text.indexOf(token, from);
  return at === -1 ? -1 : at + token.length;
};

/** The index just past a doctype whose body starts at `from`, honoring quotes and its internal subset. */
const afterDoctype = (text, from) => {
  let inSubset = false;
  let at = from;
  while (at !== -1 && at < text.length) {
    const char = text[at];
    if (char === '"' || char === "'") at = after(text, char, at + 1);
    else if (inSubset && text.startsWith('<!--', at)) at = after(text, '-->', at + 4);
    else if (inSubset && text.startsWith('<?', at)) at = after(text, '?>', at + 2);
    else if (char === '>' && !inSubset) return at + 1;
    else {
      if (char === '[') inSubset = true;
      else if (char === ']') inSubset = false;
      at += 1;
    }
  }
  return -1;
};

/**
 * Whether an XML document's root element is <svg>, after any processing
 * instructions, comments, and a doctype. One forward pass, so no input can
 * make it slow, and quoted text never counts as markup.
 */
const hasSvgRoot = (text) => {
  let at = 0;
  while (at !== -1) {
    while (/\s/.test(text.charAt(at))) at += 1;
    if (text.startsWith('<?', at)) at = after(text, '?>', at + 2);
    else if (text.startsWith('<!--', at)) at = after(text, '-->', at + 4);
    else if (text.slice(at, at + 9).toLowerCase() === '<!doctype') at = afterDoctype(text, at + 9);
    // XML names are case-sensitive, and only these characters can end one here.
    else return /^<svg[ \t\r\n/>]/.test(text.slice(at, at + 5));
  }
  return false;
};

/**
 * Whether file bytes are an image, whatever the file is named, so a symlink or
 * renamed file cannot carry other data, such as a secret, into a page.
 */
const isImageBytes = (bytes) => {
  const head = latin1(bytes, 0, 12);
  if (
    head.startsWith('\x89PNG')
    || head.startsWith('\xff\xd8\xff')
    || head.startsWith('GIF8')
    || head.startsWith('\0\0\x01\0')
    || (head.startsWith('BM') && head.slice(6, 10) === '\0\0\0\0')
    || (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP')
    || /^ftyp(?:avif|avis|mif1)$/.test(head.slice(4, 12))
  ) {
    return true;
  }
  return hasSvgRoot(new TextDecoder().decode(bytes.subarray(0, 4096)));
};

const statFileSize = async (path) => {
  try {
    const info = await stat(filePathFor(path));
    return info.isFile() ? info.size : undefined;
  } catch {
    return undefined;
  }
};

// Reads at most `limit` bytes, so a file that grew after `stat` cannot blow up memory.
const readUpTo = async (path, limit) => {
  let handle;
  try {
    handle = await open(filePathFor(path), 'r');
    const buffer = Buffer.alloc(limit);
    let total = 0;
    while (total < limit) {
      const { bytesRead } = await handle.read(buffer, total, limit - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    return buffer.subarray(0, total);
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
};

/**
 * Replaces every local image reference with a data URI. Returns the page and
 * the paths that could not be read (left as written); throws an
 * `HtmlRenderRequestError` when an image or the page is too large.
 */
export const inlineLocalImages = async (html) => {
  const references = findLocalImages(html);
  const paths = [...new Set(references.map((reference) => reference.path))];
  const files = await Promise.all(paths.map(async (path) => ({ path, size: await statFileSize(path) })));
  const oversized = files.find((file) => file.size !== undefined && file.size > HTML_RENDER_MAX_IMAGE_BYTES);
  if (oversized) throw imageTooLargeError(oversized.path, oversized.size);
  const sizes = new Map(files.map((file) => [file.path, file.size]));
  const pageBytes = references.reduce((total, reference) => {
    const size = sizes.get(reference.path);
    return size === undefined
      ? total
      : total + dataUriPrefix(reference.path).length + Math.ceil(size / 3) * 4 - Buffer.byteLength(reference.path);
  }, Buffer.byteLength(html));
  if (pageBytes > HTML_RENDER_MAX_PAGE_BYTES) throw pageTooLargeError(pageBytes);

  // Files can grow after `stat`. Each read stops one byte past the image
  // limit, and reading stops once the images read so far cannot fit the page.
  let readBytes = 0;
  const dataUris = new Map();
  for (const file of files) {
    if (file.size === undefined) continue;
    const bytes = await readUpTo(file.path, HTML_RENDER_MAX_IMAGE_BYTES + 1);
    if (!bytes || !isImageBytes(bytes)) continue;
    if (bytes.byteLength > HTML_RENDER_MAX_IMAGE_BYTES) throw imageTooLargeError(file.path, bytes.byteLength);
    readBytes += Math.ceil(bytes.byteLength / 3) * 4;
    if (readBytes > HTML_RENDER_MAX_PAGE_BYTES) throw pageTooLargeError(readBytes);
    dataUris.set(file.path, dataUriPrefix(file.path) + bytes.toString('base64'));
  }

  const parts = [];
  let cursor = 0;
  for (const reference of references) {
    const dataUri = dataUris.get(reference.path);
    if (dataUri === undefined) continue;
    parts.push(html.slice(cursor, reference.start), dataUri);
    cursor = reference.end;
  }
  parts.push(html.slice(cursor));
  const inlined = parts.join('');
  const inlinedBytes = Buffer.byteLength(inlined);
  if (inlinedBytes > HTML_RENDER_MAX_PAGE_BYTES) throw pageTooLargeError(inlinedBytes);
  return { html: inlined, missing: files.filter((file) => !dataUris.has(file.path)).map((file) => file.path) };
};
