import { describe, expect, it } from 'vitest';

import {
  SUBAGENT_ASYNC_STATUS_LINE_PREFIX,
  clampExtensionWidgetLine,
  extensionWidgetLineLimit,
  sanitizeExtensionFormFields,
  validateExtensionFormValues,
} from './extension-protocol.js';

describe('extension widget line limits', () => {
  const prefix = SUBAGENT_ASYNC_STATUS_LINE_PREFIX;

  it('clamps ordinary lines to 2000 characters', () => {
    expect(clampExtensionWidgetLine('todo', 0, 'a'.repeat(2500))).toHaveLength(2000);
    expect(clampExtensionWidgetLine('todo', 0, 'short')).toBe('short');
    expect(clampExtensionWidgetLine('todo', 0, 42)).toBe('42');
    expect(extensionWidgetLineLimit('subagent-async', 0, `x${prefix}`)).toBe(2000);
  });

  it('keeps line 0 of subagent-async whole up to prefix plus 32 KiB', () => {
    const limit = prefix.length + 32 * 1024;
    expect(extensionWidgetLineLimit('subagent-async', 0, `${prefix}{}`)).toBe(limit);
    const whole = `${prefix}${'a'.repeat(32 * 1024)}`;
    expect(clampExtensionWidgetLine('subagent-async', 0, whole)).toBe(whole);
    expect(clampExtensionWidgetLine('subagent-async', 0, `${whole}b`)).toBe(whole);
  });

  it('clamps a prefixed line under another widget key', () => {
    const line = `${prefix}${'a'.repeat(5000)}`;
    expect(extensionWidgetLineLimit('todo', 0, line)).toBe(2000);
    expect(clampExtensionWidgetLine('todo', 0, line)).toHaveLength(2000);
    expect(clampExtensionWidgetLine('subagent-async-extra', 0, line)).toHaveLength(2000);
  });

  it('clamps a prefixed line at any index other than 0 of subagent-async', () => {
    const line = `${prefix}${'a'.repeat(5000)}`;
    expect(extensionWidgetLineLimit('subagent-async', 1, line)).toBe(2000);
    expect(clampExtensionWidgetLine('subagent-async', 1, line)).toHaveLength(2000);
    expect(clampExtensionWidgetLine('subagent-async', 99, line)).toHaveLength(2000);
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
