export const MAX_EXTENSION_APP_HTML_CHARS = 200_000;
const MAX_EXTENSION_WIDGET_LINE_CHARS = 2000;

/**
 * pi-subagents publishes its async run status to RPC hosts as exactly one line,
 * line 0 of the widget `subagent-async`: `PI_SUBAGENT_ASYNC_JSON:` plus a JSON
 * snapshot capped at 32 KiB (`maxSerializedBytes` in pi-subagents'
 * async-status-projection). Cutting that JSON at the ordinary widget line limit
 * would break it, so that one position keeps its payload whole up to the
 * producer's cap. Every other line, including a prefixed line under another key
 * or at another index, keeps `MAX_EXTENSION_WIDGET_LINE_CHARS`, so a widget
 * stays within the bound it had before.
 */
const SUBAGENT_ASYNC_WIDGET_KEY = 'subagent-async';
export const SUBAGENT_ASYNC_STATUS_LINE_PREFIX = 'PI_SUBAGENT_ASYNC_JSON:';
const MAX_SUBAGENT_ASYNC_STATUS_PAYLOAD_CHARS = 32 * 1024;

export const extensionWidgetLineLimit = (key, index, line) => (
  key === SUBAGENT_ASYNC_WIDGET_KEY
    && index === 0
    && typeof line === 'string'
    && line.startsWith(SUBAGENT_ASYNC_STATUS_LINE_PREFIX)
    ? SUBAGENT_ASYNC_STATUS_LINE_PREFIX.length + MAX_SUBAGENT_ASYNC_STATUS_PAYLOAD_CHARS
    : MAX_EXTENSION_WIDGET_LINE_CHARS
);

/** `index` is the line's position in the widget as published, before any filtering. */
export const clampExtensionWidgetLine = (key, index, line) => {
  const text = String(line);
  return text.slice(0, extensionWidgetLineLimit(key, index, text));
};
const MAX_EXTENSION_FORM_FIELDS = 12;
const MAX_EXTENSION_FORM_OPTIONS = 20;

const FORM_FIELD_TYPES = new Set(['text', 'textarea', 'number', 'select', 'checkbox']);

/**
 * Normalize extension-authored form descriptors at both sides of the private
 * daemon IPC seam. Keeping this in one module prevents the daemon bridge and
 * public route projection from accepting different field shapes.
 */
export const sanitizeExtensionFormFields = (fields) => {
  if (!Array.isArray(fields)) return [];
  return fields.slice(0, MAX_EXTENSION_FORM_FIELDS).flatMap((field) => {
    if (!field || typeof field !== 'object') return [];
    const id = typeof field.id === 'string' ? field.id.slice(0, 128) : '';
    const label = typeof field.label === 'string' ? field.label.slice(0, 256) : '';
    if (!id || !label) return [];
    return [{
      id,
      label,
      type: FORM_FIELD_TYPES.has(field.type) ? field.type : 'text',
      ...(field.required === true ? { required: true } : {}),
      ...(typeof field.placeholder === 'string' ? { placeholder: field.placeholder.slice(0, 256) } : {}),
      ...(Array.isArray(field.options)
        ? {
            options: field.options
              .filter((option) => typeof option === 'string')
              .map((option) => option.slice(0, 256))
              .slice(0, MAX_EXTENSION_FORM_OPTIONS),
          }
        : {}),
      ...(typeof field.initial === 'string' ? { initial: field.initial.slice(0, 2_000) } : {}),
      ...(Number.isFinite(field.min) ? { min: field.min } : {}),
      ...(Number.isFinite(field.max) ? { max: field.max } : {}),
    }];
  });
};

/** Validate a form answer against the exact descriptor sent to the client. */
export const validateExtensionFormValues = (fields, values) => {
  if (!Array.isArray(fields) || !values || typeof values !== 'object' || Array.isArray(values)) return false;
  const fieldsById = new Map(fields.map((field) => [field.id, field]));
  for (const key of Object.keys(values)) if (!fieldsById.has(key)) return false;
  for (const field of fields) {
    const value = values[field.id];
    if (field.required === true && (typeof value !== 'string' || value.length === 0)) return false;
    if (value === undefined || value.length === 0) continue;
    if (typeof value !== 'string') return false;
    if (field.type === 'number') {
      const number = Number(value);
      if (!Number.isFinite(number)) return false;
      if (typeof field.min === 'number' && number < field.min) return false;
      if (typeof field.max === 'number' && number > field.max) return false;
    } else if (field.type === 'select' && !field.options?.includes(value)) {
      return false;
    } else if (field.type === 'checkbox' && value !== 'true' && value !== 'false') {
      return false;
    }
  }
  return true;
};
