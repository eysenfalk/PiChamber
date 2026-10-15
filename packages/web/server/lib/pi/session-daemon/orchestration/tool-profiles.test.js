import { describe, expect, it } from 'vitest';

import { keptExtensionPaths, recordedProfile, resolveProfile, toolAllowed } from './tool-profiles.js';

describe('worker tool profiles', () => {
  it('blocks the writing tools of read-only, with and without an MCP proxy prefix, and keeps bash and reading', () => {
    const profile = resolveProfile({ role: 'review' });
    expect(profile.name).toBe('read-only');
    for (const name of ['edit', 'write', 'aft_delete', 'mcp__aft_pi__aft_move', 'ast_grep_replace', 'mcp__aft_pi__ast_grep_replace', 'subagent', 'subagent_supervisor', 'mcp__subagents__subagent']) {
      expect(toolAllowed(profile, name)).toBe(false);
    }
    for (const name of ['read', 'bash', 'grep', 'aft_search', 'aft_outline', 'ast_grep_search', 'mcp__pichamber__worker_report', 'fabric_exec']) {
      expect(toolAllowed(profile, name)).toBe(true);
    }
  });

  it('defaults research and other roles to full and lets an explicit profile win', () => {
    expect(resolveProfile({ role: 'research' }).name).toBe('full');
    expect(resolveProfile({}).name).toBe('full');
    expect(resolveProfile({ role: 'oracle' }).name).toBe('read-only');
    expect(resolveProfile({ role: 'review', profile: 'full' }).name).toBe('full');
    expect(() => resolveProfile({ profile: 'constructor' })).toThrow(/Unknown profile/);
  });

  it('keeps an unrecorded profile unrestricted and runs an unreadable one with reading tools only', () => {
    expect(recordedProfile(undefined)).toBeUndefined();
    expect(recordedProfile({ opId: 'op_1' })).toBeUndefined();
    expect(toolAllowed(undefined, 'write')).toBe(true);
    const broken = recordedProfile({ opId: 'op_1', profile: { name: 'read-only', excludeTools: 'edit' } });
    expect(broken).toBeNull();
    expect(toolAllowed(broken, 'read')).toBe(true);
    expect(['bash', 'write', 'mcp__pichamber__worker_report'].some((name) => toolAllowed(broken, name))).toBe(false);
  });

  it('keeps the enabled extension resources that no pattern excludes by path or package source', () => {
    const resources = [
      { path: '/home/u/.pi/agent/npm/node_modules/pi-intercom/index.ts', enabled: true, metadata: { source: 'npm:pi-intercom' } },
      { path: '/home/u/.pi/agent/extensions/notes.ts', enabled: true, metadata: { source: 'local' } },
      { path: '/home/u/.pi/agent/extensions/kept.ts', enabled: true, metadata: { source: 'local' } },
      { path: '/home/u/.pi/agent/extensions/off.ts', enabled: false, metadata: { source: 'local' } },
    ];
    const profile = resolveProfile({ excludeExtensions: ['npm:pi-intercom', '*/notes.ts'] });
    expect(keptExtensionPaths(resources, profile)).toEqual(['/home/u/.pi/agent/extensions/kept.ts']);
    expect(keptExtensionPaths(resources, resolveProfile({}))).toHaveLength(3);
    expect(keptExtensionPaths(resources, null)).toEqual([]);
  });
});
