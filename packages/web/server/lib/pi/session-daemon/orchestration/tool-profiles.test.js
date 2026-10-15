import { describe, expect, it } from 'vitest';

import { recordedProfile, resolveProfile, toolAllowed, withoutExcludedExtensions } from './tool-profiles.js';

const extension = (path, source) => ({ path, sourceInfo: { source } });

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

  it('drops excluded extensions by path or package source and always keeps the inline ones', () => {
    const loaded = {
      extensions: [
        extension('<inline:pichamber-orchestration>', 'inline'),
        extension('/home/u/.pi/agent/npm/node_modules/pi-intercom/index.ts', 'npm:pi-intercom'),
        extension('/home/u/.pi/agent/extensions/notes.ts', 'local'),
      ],
      errors: [],
    };
    const profile = resolveProfile({ excludeExtensions: ['npm:pi-intercom', '*/notes.ts'] });
    expect(withoutExcludedExtensions(loaded, profile).extensions.map((item) => item.path)).toEqual(['<inline:pichamber-orchestration>']);
    expect(withoutExcludedExtensions(loaded, resolveProfile({})).extensions).toHaveLength(3);
    expect(withoutExcludedExtensions(loaded, undefined)).toBe(loaded);
    expect(withoutExcludedExtensions(loaded, null).extensions.map((item) => item.path)).toEqual(['<inline:pichamber-orchestration>']);
  });
});
