/**
 * Byte-level scans for Pi `session_info` (rename) entries in a session JSONL
 * file. They work on raw buffers so a scan never splits a UTF-8 character
 * and only lines that contain the `"session_info"` marker are decoded and
 * parsed. Pi appends one JSON entry per LF-terminated line.
 */

const SCAN_CHUNK_BYTES = 256 * 1024;
const NEWLINE = 0x0a;
// Inside a JSON string the quotes are escaped, so this raw byte sequence only
// matches an unescaped `"session_info"` token. The type check below decides.
const SESSION_INFO_MARKER = Buffer.from('"session_info"');

const parseSessionInfoLine = (line) => {
  if (line.length === 0 || line.indexOf(SESSION_INFO_MARKER) === -1) return undefined;
  try {
    const entry = JSON.parse(line.toString('utf8'));
    return entry?.type === 'session_info' ? entry : undefined;
  } catch {
    return undefined;
  }
};

const readChunk = async (handle, position, size) => {
  const chunk = Buffer.alloc(size);
  let filled = 0;
  while (filled < size) {
    const { bytesRead } = await handle.read(chunk, filled, size - filled, position + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return filled === size ? chunk : chunk.subarray(0, filled);
};

/**
 * Walk `[start, end)` from the end towards `start` and return the latest
 * `session_info` entry, stopping at the first one found.
 *
 * `completeEnd` is the offset just after the last LF in the range (or `start`
 * when the range holds none); a trailing piece without LF may still be
 * mid-write, so callers resume later scans from `completeEnd`. A trailing
 * piece that already parses as `session_info` is still returned.
 * A fragment at `start` that is not a whole line fails to parse and is
 * ignored, so callers pass a `start` on a line boundary.
 */
export async function findLatestSessionInfoBackward(handle, { start, end }) {
  let position = end;
  let completeEnd;
  // Pieces, in file order, of the line that continues past the current chunk.
  let carry = [];
  while (position > start) {
    const size = Math.min(SCAN_CHUNK_BYTES, position - start);
    position -= size;
    const chunk = await readChunk(handle, position, size);
    let lineEnd = chunk.length;
    let newline = chunk.lastIndexOf(NEWLINE, lineEnd - 1);
    while (newline !== -1) {
      if (completeEnd === undefined) completeEnd = position + newline + 1;
      const head = chunk.subarray(newline + 1, lineEnd);
      const line = carry.length > 0 ? Buffer.concat([head, ...carry]) : head;
      carry = [];
      const entry = parseSessionInfoLine(line);
      if (entry) return { entry, completeEnd };
      lineEnd = newline;
      newline = lineEnd > 0 ? chunk.lastIndexOf(NEWLINE, lineEnd - 1) : -1;
    }
    if (lineEnd > 0) carry.unshift(chunk.subarray(0, lineEnd));
  }
  const entry = carry.length > 0 ? parseSessionInfoLine(Buffer.concat(carry)) : undefined;
  return { entry, completeEnd: completeEnd ?? start };
}

/**
 * Read `[start, end)` forward and return the last `session_info` entry in it.
 * `completeEnd` has the same meaning as for the backward scan.
 */
export async function findLatestSessionInfoForward(handle, { start, end }) {
  let position = start;
  let completeEnd = start;
  let latest;
  // Pieces, in file order, of the line that started in an earlier chunk.
  let pending = [];
  while (position < end) {
    const size = Math.min(SCAN_CHUNK_BYTES, end - position);
    const chunk = await readChunk(handle, position, size);
    if (chunk.length === 0) break;
    let lineStart = 0;
    let newline = chunk.indexOf(NEWLINE, lineStart);
    while (newline !== -1) {
      const piece = chunk.subarray(lineStart, newline);
      const line = pending.length > 0 ? Buffer.concat([...pending, piece]) : piece;
      pending = [];
      const entry = parseSessionInfoLine(line);
      if (entry) latest = entry;
      lineStart = newline + 1;
      completeEnd = position + lineStart;
      newline = chunk.indexOf(NEWLINE, lineStart);
    }
    if (lineStart < chunk.length) pending.push(chunk.subarray(lineStart));
    position += chunk.length;
  }
  const trailing = pending.length > 0 ? parseSessionInfoLine(Buffer.concat(pending)) : undefined;
  return { entry: trailing ?? latest, completeEnd };
}
