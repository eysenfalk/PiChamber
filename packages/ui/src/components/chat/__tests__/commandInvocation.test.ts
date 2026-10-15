import { describe, expect, test } from 'bun:test';

import {
  commandInvocationName,
  commandMatchesCategory,
  filterAndSortCommands,
  mergeCommandAutocompleteItems,
} from '../commandAutocompleteItems';

describe('command autocomplete — invocation identity', () => {
  type TestItem = {
    name: string;
    invocationName?: string;
    source?: "pichamber" | "system" | "pi" | "skill" | "extension" | "prompt";
    description?: string;
    searchAliases?: string[];
    isBuiltIn?: boolean;
    isSkill?: boolean;
  };
  test('exposes executable names (skill includes prefix)', () => {
    expect(
      commandInvocationName({ name: 'code-review', invocationName: 'skill:code-review' }),
    ).toBe('skill:code-review');
    expect(commandInvocationName({ name: 'review' })).toBe('review');
  });

  test('/review and /skill:review do not collide', () => {
    const prompt: TestItem = { name: 'review', invocationName: 'review', source: 'prompt' };
    const skill: TestItem = {
      name: 'review',
      invocationName: 'skill:review',
      source: 'skill',
      isSkill: true,
    };
    const merged = mergeCommandAutocompleteItems([], [], [skill], [prompt]);
    expect(merged.map((m) => commandInvocationName(m)).sort()).toEqual([
      'review',
      'skill:review',
    ]);
  });

  test('prompt/extension collision on /review matches Pi precedence (extension wins)', () => {
    const prompt: TestItem = { name: 'review', invocationName: 'review', source: 'prompt' };
    const extension: TestItem = {
      name: 'review',
      invocationName: 'review',
      source: 'extension',
    };
    const merged = mergeCommandAutocompleteItems([], [extension], [], [prompt]);
    expect(merged).toHaveLength(1);
    expect(merged[0].source).toBe('extension');
  });

  test('category filtering uses source, not naming heuristics', () => {
    const skill: TestItem = {
      name: 'review',
      invocationName: 'skill:review',
      source: 'skill',
      isSkill: true,
    };
    expect(commandMatchesCategory(skill, 'skills')).toBe(true);
    expect(commandMatchesCategory(skill, 'prompts')).toBe(false);
    expect(
      commandMatchesCategory(
        { name: 'undo', invocationName: 'undo', source: 'system' as const, isBuiltIn: true },
        'system',
      ),
    ).toBe(true);
  });

  test('search matches invocation and description (snippets never appear here)', () => {
    const skill: TestItem = {
      name: 'code-review',
      invocationName: 'skill:code-review',
      source: 'skill',
      isSkill: true,
      description: 'Shows a description',
    };
    const search = (query: string) => filterAndSortCommands([skill], query, 'all').length === 1;
    expect(search('skill:code')).toBe(true);
    expect(search('code-review')).toBe(true);
    expect(search('deploy')).toBe(false);
    expect(search('Review code')).toBe(true); // tokens match separately, as in Pi
    expect(search('description')).toBe(true); // description match, ranked after name matches
    // Snippets use #name and must never be in the slash catalog; a # trigger
    // is not a slash invocation.
    expect(search('#sig')).toBe(false);
  });
});
