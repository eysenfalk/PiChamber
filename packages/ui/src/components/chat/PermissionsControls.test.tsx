import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PermissionsControls } from './PermissionsControls';
import { dispatchPermissionControl, parsePermissionStatus, permissionModeCommand } from '@/lib/pi/permissions';

describe('native permissions controls', () => {
  test('renders authoritative mode and read-only state with accessible controls', () => {
    const markup = renderToStaticMarkup(<PermissionsControls sessionId="owner" text="permissions/v1 mode=auto readOnly=on" />);
    expect(markup).toContain('Session permissions'); expect(markup).toContain('Permission mode');
    expect(markup).toContain('Read-only override'); expect(markup).toContain('value="auto" selected');
    expect(markup).toContain('aria-checked="true"');
  });
  test('yolo exposes unrestricted behavior and never implies read-only enforcement', () => {
    const markup = renderToStaticMarkup(<PermissionsControls sessionId="owner" text="permissions/v1 mode=yolo readOnly=on" />);
    expect(markup).toContain('All checks bypassed'); expect(markup).toContain('Read-only (bypassed)');
  });
  test('missing, malformed, invalid-config, or legacy state does not create controls', () => {
    for (const text of ['', 'perm: auto', 'permissions/v2 mode=auto readOnly=on', 'permissions/v1 mode=invalid readOnly=on', 'permissions: unavailable (invalid configuration)']) {
      expect(parsePermissionStatus(text)).toBeNull();
      expect(renderToStaticMarkup(<PermissionsControls sessionId="owner" text={text} />)).toBe('');
    }
  });
  test('dispatch targets the captured session, keeps exact commands, and propagates failures', async () => {
    const calls: string[][] = [];
    const prompt = async (session: string, text: string) => { calls.push([session, text]); };
    await dispatchPermissionControl('session-A', '/permissions yolo', prompt);
    await dispatchPermissionControl('session-B', '/read-only off', prompt);
    expect(calls).toEqual([['session-A','/permissions yolo'], ['session-B','/read-only off']]);
    expect(permissionModeCommand('yolo\n/write')).toBeNull();
    await expect(dispatchPermissionControl('', '/permissions auto', prompt)).rejects.toThrow();
    await expect(dispatchPermissionControl('closed', '/permissions ask', async () => { throw new Error('closed'); })).rejects.toThrow('closed');
    expect(calls).toHaveLength(2);
  });
});
