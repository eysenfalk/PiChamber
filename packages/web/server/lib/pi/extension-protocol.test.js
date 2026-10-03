import { describe, expect, it } from 'vitest';

import {
  SUBAGENT_ASYNC_STATUS_LINE_PREFIX,
  clampExtensionWidgetLine,
  extensionWidgetLineLimit,
  sanitizeExtensionFormFields,
  validateExtensionFormValues,
} from './extension-protocol.js';

describe('extension widget line limits', () => {
  it('clamps ordinary lines to 2000 characters', () => {
    expect(clampExtensionWidgetLine('a'.repeat(2500))).toHaveLength(2000);
    expect(clampExtensionWidgetLine('short')).toBe('short');
    expect(clampExtensionWidgetLine(42)).toBe('42');
    expect(extensionWidgetLineLimit(`x${SUBAGENT_ASYNC_STATUS_LINE_PREFIX}`)).toBe(2000);
  });

  it('keeps a pi-subagents async status line whole up to prefix plus 32 KiB', () => {
    const limit = SUBAGENT_ASYNC_STATUS_LINE_PREFIX.length + 32 * 1024;
    expect(extensionWidgetLineLimit(`${SUBAGENT_ASYNC_STATUS_LINE_PREFIX}{}`)).toBe(limit);
    const whole = `${SUBAGENT_ASYNC_STATUS_LINE_PREFIX}${'a'.repeat(32 * 1024)}`;
    expect(clampExtensionWidgetLine(whole)).toBe(whole);
    expect(clampExtensionWidgetLine(`${whole}b`)).toBe(whole);
  });
});

describe('extension form protocol', () => {
  it('uses one bounded field projection for daemon and public routes', () => {
    const fields = sanitizeExtensionFormFields([
      { id: 'name', label: 'Name', type: 'text', required: true, placeholder: 'x'.repeat(300) },
      { id: 'mode', label: 'Mode', type: 'select', options: ['fast', 'safe'] },
      { id: 'count', label: 'Count', type: 'number', min: 1, max: 3 },
      { id: '', label: 'Invalid' },
    ]);
    expect(fields).toHaveLength(3);
    expect(fields[0].placeholder).toHaveLength(256);
    expect(fields[1].options).toEqual(['fast', 'safe']);
  });

  it('rejects unknown, malformed, and out-of-range answers', () => {
    const fields = sanitizeExtensionFormFields([
      { id: 'name', label: 'Name', type: 'text', required: true },
      { id: 'mode', label: 'Mode', type: 'select', options: ['fast', 'safe'] },
      { id: 'count', label: 'Count', type: 'number', min: 1, max: 3 },
      { id: 'enabled', label: 'Enabled', type: 'checkbox' },
    ]);
    expect(validateExtensionFormValues(fields, {
      name: 'worker', mode: 'safe', count: '2', enabled: 'true',
    })).toBe(true);
    expect(validateExtensionFormValues(fields, { name: 'worker', unknown: 'x' })).toBe(false);
    expect(validateExtensionFormValues(fields, { name: '', mode: 'safe' })).toBe(false);
    expect(validateExtensionFormValues(fields, { name: 'worker', mode: 'turbo' })).toBe(false);
    expect(validateExtensionFormValues(fields, { name: 'worker', count: '4' })).toBe(false);
    expect(validateExtensionFormValues(fields, { name: 'worker', enabled: 'yes' })).toBe(false);
  });
});
