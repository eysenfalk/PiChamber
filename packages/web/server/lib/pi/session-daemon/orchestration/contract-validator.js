// Validates tool arguments against the JSON Schema contracts in
// tool-contracts.js, so both adapters (inline extension and MCP endpoint) get
// the same bounds from the one authoritative description. It covers exactly
// the keywords those contracts use; `SUPPORTED_KEYWORDS` is checked by a test
// so a contract cannot silently use a keyword this validator ignores.

export const SUPPORTED_KEYWORDS = new Set([
  'type', 'enum', 'description', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum',
  'minItems', 'maxItems', 'items', 'required', 'properties', 'additionalProperties',
]);

const TYPE_CHECKS = {
  object: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
  array: (value) => Array.isArray(value),
  string: (value) => typeof value === 'string',
  integer: (value) => Number.isSafeInteger(value),
  number: (value) => typeof value === 'number' && Number.isFinite(value),
  boolean: (value) => typeof value === 'boolean',
};

/** The first violation of `schema` by `value` as a message naming `path`, or null. */
export const schemaViolation = (schema, value, path = 'arguments') => {
  if (schema.type && !TYPE_CHECKS[schema.type]?.(value)) {
    return `${path} must be ${schema.type === 'integer' ? 'an integer' : `a ${schema.type}`}.`;
  }
  if (schema.enum && !schema.enum.includes(value)) return `${path} must be one of: ${schema.enum.join(', ')}.`;
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) return `${path} must have at least ${schema.minLength} characters.`;
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return `${path} must have at most ${schema.maxLength} characters.`;
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) return `${path} has an invalid format.`;
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) return `${path} must be at least ${schema.minimum}.`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${path} must be at most ${schema.maximum}.`;
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return `${path} must have at least ${schema.minItems} items.`;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${path} must have at most ${schema.maxItems} items.`;
    if (schema.items) {
      for (let index = 0; index < value.length; index += 1) {
        const violation = schemaViolation(schema.items, value[index], `${path}[${index}]`);
        if (violation) return violation;
      }
    }
  }
  if (TYPE_CHECKS.object(value) && (schema.properties || schema.required)) {
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (value[key] === undefined) return `${path}.${key} is required.`;
    }
    for (const [key, item] of Object.entries(value)) {
      if (!Object.hasOwn(properties, key)) {
        if (schema.additionalProperties === false) return `${path}.${key} is not allowed.`;
        continue;
      }
      if (item === undefined) continue;
      const violation = schemaViolation(properties[key], item, `${path}.${key}`);
      if (violation) return violation;
    }
  }
  return null;
};
