import { describe, expect, it } from 'vitest';
import { projectNestedToolCalls } from './nested-tool-calls.js';

const editAudit = {
  ref: 'pi.edit',
  tool: 'edit',
  provider: 'pi',
  success: true,
  args: { path: '/repo/a.md', edits: [{ oldString: 'a', newString: 'b' }] },
  result: { ok: true, output: 'Edited (+1/-1, 1 edits).', details: { diff: '- 1 a\n+ 1 b' } },
  startedAt: 10,
  endedAt: 20,
};

describe('projectNestedToolCalls', () => {
  it('leaves other tools and non-record metadata untouched', () => {
    const metadata = { audits: [editAudit] };
    expect(projectNestedToolCalls('edit', metadata)).toBe(metadata);
    expect(projectNestedToolCalls('fabric_exec', undefined)).toBeUndefined();
  });

  it('leaves fabric details without nested calls untouched', () => {
    const metadata = { progress: 'working', audits: [] };
    expect(projectNestedToolCalls('fabric_exec', metadata)).toBe(metadata);
  });

  it('projects an edit audit with its diff as call metadata and drops raw audits and trace', () => {
    const result = projectNestedToolCalls('fabric_exec', {
      success: true,
      kernel: 'typescript',
      audits: [editAudit],
      trace: { operations: [] },
      phases: ['run'],
    });
    expect(result).toEqual({
      success: true,
      kernel: 'typescript',
      phases: ['run'],
      nestedCalls: [{
        name: 'edit',
        input: editAudit.args,
        success: true,
        output: 'Edited (+1/-1, 1 edits).',
        metadata: { diff: '- 1 a\n+ 1 b' },
        startedAt: 10,
        endedAt: 20,
      }],
    });
  });

  it('maps string results, failures, and unknown result shapes', () => {
    const result = projectNestedToolCalls('fabric_exec', {
      audits: [
        { ref: 'pi.read', tool: 'read', provider: 'pi', success: true, args: { path: '/x' }, result: 'file text' },
        { ref: 'pi.bash', tool: 'bash', success: false, error: 'exit 1', args: { command: 'false' } },
        { ref: 'mcp.srv.lookup', success: true, result: { hits: 2 } },
        { ref: 'pi.grep', tool: 'grep' },
      ],
    });
    const calls = result.nestedCalls;
    expect(calls.map((call) => call.name)).toEqual(['read', 'bash', 'lookup', 'grep']);
    expect(calls[0].output).toBe('file text');
    expect(calls[1]).toMatchObject({ success: false, error: 'exit 1' });
    expect(JSON.parse(calls[2].output)).toEqual({ hits: 2 });
    expect(calls[3].success).toBeUndefined();
  });

  it('keeps the run progress and phases next to the projected calls, and a call without an outcome stays running', () => {
    const projected = projectNestedToolCalls('fabric_exec', {
      progress: 'Calling pi.bash',
      phases: ['plan', 'build'],
      audits: [
        { ref: 'pi.read', tool: 'read', args: { path: 'a' }, success: true, startedAt: 1, endedAt: 2 },
        { ref: 'pi.bash', tool: 'bash', args: { command: 'ls' }, startedAt: 3 },
      ],
    });
    expect(projected.progress).toBe('Calling pi.bash');
    expect(projected.phases).toEqual(['plan', 'build']);
    expect(projected.audits).toBeUndefined();
    expect(projected.nestedCalls[0].success).toBe(true);
    expect(projected.nestedCalls[1].success).toBeUndefined();
    expect(projected.nestedCalls[1].startedAt).toBe(3);
  });

  it('falls back to trace operations when audits are absent', () => {
    const result = projectNestedToolCalls('fabric_exec', {
      trace: {
        operations: [
          { type: 'call', sequence: 0, ref: 'pi.edit', action: 'edit', args: { path: '/a' }, outcome: 'succeeded', result: { ok: true, output: 'ok', details: { diff: 'd' } } },
          { type: 'call', sequence: 1, ref: 'pi.bash', action: 'bash', args: {}, outcome: 'failed', error: 'boom' },
        ],
      },
    });
    expect(result.nestedCalls).toEqual([
      { name: 'edit', input: { path: '/a' }, success: true, output: 'ok', metadata: { diff: 'd' } },
      { name: 'bash', input: {}, success: false, error: 'boom' },
    ]);
    expect(result.trace).toBeUndefined();
  });

  it('caps the number of calls and the size of one call output', () => {
    const audits = Array.from({ length: 250 }, (_, index) => ({
      ref: 'pi.read', tool: 'read', success: true, args: { path: String(index) }, result: 'x'.repeat(index === 0 ? 80_000 : 1),
    }));
    const calls = projectNestedToolCalls('fabric_exec', { audits }).nestedCalls;
    expect(calls).toHaveLength(200);
    expect(calls[0].output).toHaveLength(50_000);
  });

  it('skips entries without a usable ref', () => {
    const calls = projectNestedToolCalls('fabric_exec', { audits: [{ tool: 'edit' }, { ref: '' }, editAudit] }).nestedCalls;
    expect(calls).toHaveLength(1);
  });
});
