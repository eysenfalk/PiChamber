/**
 * Neutral projection of pi-fabric's `fabric_exec` execution details.
 *
 * pi-fabric runs every Pi tool as a nested call inside one `fabric_exec` tool
 * call, so the transcript only carries the outer call. Its result details list
 * the nested calls (`audits` while running and after settling, `trace`
 * operations as a fallback). This module turns that list into
 * `metadata.nestedCalls`, a tool-agnostic shape the UI renders with its
 * normal tool rows. pi-fabric specifics stay here; the UI never reads
 * `audits` or `trace`.
 *
 * Input is metadata that already went through attachment redaction.
 */

const FABRIC_EXEC_TOOL_NAME = 'fabric_exec';

const MAX_NESTED_CALLS = 200;
const MAX_NESTED_OUTPUT_CHARS = 50_000;

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

const finiteNumber = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

const capText = (text) => (
  text.length > MAX_NESTED_OUTPUT_CHARS ? text.slice(0, MAX_NESTED_OUTPUT_CHARS) : text
);

const stringifyResult = (value) => {
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return '';
  }
};

/** Audit-shaped entries from either persisted audits or trace operations. */
const readEntries = (details) => {
  if (Array.isArray(details.audits)) return details.audits.filter(isRecord);
  const operations = isRecord(details.trace) && Array.isArray(details.trace.operations) ? details.trace.operations : null;
  if (!operations) return [];
  return operations.filter(isRecord).map((operation) => ({
    ref: operation.ref,
    tool: operation.action,
    success: operation.outcome === 'succeeded',
    error: operation.error,
    args: operation.args,
    result: operation.result,
    resultTruncated: operation.resultTruncated,
  }));
};

/**
 * Pi tool results arrive as `{ ok, output, details }`; read-like tools and
 * providers return a bare string or JSON value. `details` carries the edit
 * diff the UI already understands, so it becomes the call's metadata.
 */
const readResult = (result) => {
  if (result === undefined || result === null) return {};
  if (typeof result === 'string') return { output: capText(result) };
  if (isRecord(result) && typeof result.output === 'string') {
    return {
      output: capText(result.output),
      ...(isRecord(result.details) && Object.keys(result.details).length > 0 ? { metadata: result.details } : {}),
    };
  }
  const text = stringifyResult(result);
  return text ? { output: capText(text) } : {};
};

const projectEntry = (entry) => {
  if (typeof entry.ref !== 'string' || entry.ref.length === 0) return null;
  const name = typeof entry.tool === 'string' && entry.tool.length > 0
    ? entry.tool
    : entry.ref.split('.').pop();
  const { output, metadata } = readResult(entry.result);
  const startedAt = finiteNumber(entry.startedAt);
  const endedAt = finiteNumber(entry.endedAt);
  return {
    name,
    ...(isRecord(entry.args) ? { input: entry.args } : {}),
    ...(typeof entry.success === 'boolean' ? { success: entry.success } : {}),
    ...(output ? { output } : {}),
    ...(typeof entry.error === 'string' && entry.error ? { error: entry.error } : {}),
    ...(metadata ? { metadata } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
  };
};

/**
 * Replace pi-fabric's raw `audits`/`trace` with `nestedCalls`. Any other
 * tool, or fabric details without a nested call list, pass through unchanged.
 */
export const projectNestedToolCalls = (toolName, metadata) => {
  if (toolName !== FABRIC_EXEC_TOOL_NAME || !isRecord(metadata)) return metadata;
  const entries = readEntries(metadata);
  if (entries.length === 0) return metadata;
  const nestedCalls = entries.slice(0, MAX_NESTED_CALLS).map(projectEntry).filter(Boolean);
  const { audits: _audits, trace: _trace, ...rest } = metadata;
  return nestedCalls.length > 0 ? { ...rest, nestedCalls } : metadata;
};
