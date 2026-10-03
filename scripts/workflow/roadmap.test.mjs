import { describe, expect, test } from 'bun:test';
import { END, START, loadRoadmap, moveRequest, renderRoadmap, replaceGenerated } from './roadmap.mjs';

const issue = (number, title, extra = {}) => ({ number, title, state: 'open', blockedBy: [], children: [], ...extra });

const between = (text) => text.slice(text.indexOf(START), text.indexOf(END) + END.length);

describe('rendering the roadmap', () => {
  test('the order lists open items with the first three marked Next, children nested', () => {
    const text = renderRoadmap({
      items: [
        issue(25, 'Roadmap as issues'),
        issue(11, 'Proof lab', { state: 'closed' }),
        issue(20, 'Chief of staff', { children: [issue(15, 'Show the current intent'), issue(16, 'Old', { state: 'closed' })] }),
        issue(2, 'Working on'),
        issue(3, 'Recap'),
      ],
    });
    expect(text).toContain(['1. #25 **Next**', '2. #20 **Next**', '   - #15', '3. #2 **Next**', '4. #3'].join('\n'));
    expect(text).not.toContain('#11');
    expect(text).not.toContain('#16');
  });

  test('the graph chains the items in order, hangs sub-issues off their parent, highlights Next and draws blockers', () => {
    const text = renderRoadmap({
      items: [
        issue(25, 'Roadmap'),
        issue(12, 'Closed', { state: 'closed' }),
        issue(20, 'Chief of staff', {
          children: [issue(15, 'Intent')],
          blockedBy: [issue(25, 'Roadmap'), issue(9, 'Outside'), issue(8, 'Done', { state: 'closed' })],
        }),
      ],
      next: 1,
    });
    const graph = text.slice(text.indexOf('```mermaid'), text.lastIndexOf('```'));
    expect(graph).toContain('flowchart TD');
    expect(graph).toContain('  n25["1 · #35;25 Roadmap"]:::next');
    expect(graph).toContain('  n20["2 · #35;20 Chief of staff"]\n');
    expect(graph).toContain('  n15["#35;15 Intent"]');
    expect(graph).toContain('  n9["#35;9 Outside"]:::external');
    expect(graph).toContain('  n25 --> n20');
    expect(graph).toContain('  n20 --- n15');
    expect(graph).not.toContain('n12');
    expect(graph).not.toMatch(/--> n25/);
    expect(graph).toContain('  n25 -. blocks .-> n20');
    expect(graph).toContain('  n9 -. blocks .-> n20');
    expect(graph).not.toContain('n8');
    expect(graph.match(/^ {2}n25\[/gm)).toHaveLength(1);
  });

  test('titles cannot break the graph: quotes, hashes and brackets are escaped, long titles shortened', () => {
    const text = renderRoadmap({ items: [issue(7, 'Say "hi" to #3 <now> and keep going until this title is far too long')] });
    expect(text).toContain('n7["1 · #35;7 Say #quot;hi#quot; to #35;3 #lt;now#gt; and keep going until this…"]:::next');
  });

  test('labeled issues that are not placed are listed', () => {
    expect(renderRoadmap({ items: [issue(1, 'A')], unplaced: [issue(30, 'B'), issue(31, 'C')] })).toContain(
      '**Not placed yet** (labeled `roadmap`, not a sub-issue): #30, #31',
    );
  });

  test('an empty roadmap says so and has no graph', () => {
    const text = renderRoadmap({ items: [] });
    expect(text).toContain('No open roadmap items.');
    expect(text).not.toContain('mermaid');
    expect(text.startsWith(START)).toBe(true);
    expect(text.endsWith(END)).toBe(true);
  });
});

describe('the roadmap issue body', () => {
  test('only the section between the markers is replaced', () => {
    const body = `Intro.\n\n${START}\nold\n${END}\n\n## Ideas\n\n- one\n`;
    const result = replaceGenerated(body, `${START}\nnew\n${END}`);
    expect(result).toBe(`Intro.\n\n${START}\nnew\n${END}\n\n## Ideas\n\n- one\n`);
    expect(replaceGenerated(result, between(result))).toBe(result);
  });

  test('without markers the section goes first and the rest is kept', () => {
    expect(replaceGenerated('## Ideas', `${START}\nnew\n${END}`)).toBe(`${START}\nnew\n${END}\n\n## Ideas`);
    expect(replaceGenerated('', 'x')).toBe('x');
  });
});

describe('loading the roadmap', () => {
  const github = (responses) => {
    const calls = [];
    const get = (path) => {
      calls.push(path);
      if (!(path in responses)) throw new Error(`unexpected ${path}`);
      return responses[path];
    };
    return { get, calls };
  };

  test('open sub-issues in order with children and open blockers; closed ones and summaries skip calls', () => {
    const { get, calls } = github({
      'issues/24/sub_issues?per_page=100': [
        { id: 125, number: 25, title: 'A', state: 'open', sub_issues_summary: { total: 0 }, issue_dependencies_summary: { blocked_by: 0 } },
        { id: 111, number: 11, title: 'B', state: 'closed' },
        { id: 120, number: 20, title: 'C', state: 'open', sub_issues_summary: { total: 1 } },
      ],
      'issues/20/dependencies/blocked_by?per_page=100': [
        { number: 25, title: 'A', state: 'open' },
        { number: 5, title: 'Gone', state: 'closed' },
      ],
      'issues/20/sub_issues?per_page=100': [
        { id: 115, number: 15, title: 'D', state: 'open', sub_issues_summary: { total: 0 }, issue_dependencies_summary: { blocked_by: 0 } },
      ],
      'issues?labels=roadmap&state=open&per_page=100': [
        { number: 25, title: 'A', state: 'open' },
        { number: 15, title: 'D', state: 'open' },
        { number: 30, title: 'E', state: 'open' },
        { number: 26, title: 'A pull request', state: 'open', pull_request: {} },
      ],
    });
    const { items, unplaced } = loadRoadmap(get, 24);
    expect(items).toEqual([
      { id: 125, number: 25, title: 'A', state: 'open', blockedBy: [], children: [] },
      {
        id: 120,
        number: 20,
        title: 'C',
        state: 'open',
        blockedBy: [{ number: 25, title: 'A', state: 'open' }],
        children: [{ id: 115, number: 15, title: 'D', state: 'open', blockedBy: [], children: [] }],
      },
    ]);
    expect(unplaced).toEqual([{ number: 30, title: 'E', state: 'open' }]);
    expect(calls).not.toContain('issues/11/sub_issues?per_page=100');
    expect(calls).not.toContain('issues/25/sub_issues?per_page=100');
  });

  test('a page that could be cut off fails instead of losing items', () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ id: i, number: i + 100, title: 'x', state: 'closed' }));
    const { get } = github({ 'issues/24/sub_issues?per_page=100': full });
    expect(() => loadRoadmap(get, 24)).toThrow('100 or more entries');
  });
});

describe('moving an item', () => {
  const siblings = [
    { number: 25, id: 1 },
    { number: 11, id: 2 },
    { number: 20, id: 3 },
  ];

  test('to the top, before or after another item', () => {
    expect(moveRequest(siblings, 20, { top: true })).toEqual({ sub_issue_id: 3, before_id: 1 });
    expect(moveRequest(siblings, 25, { before: 20 })).toEqual({ sub_issue_id: 1, before_id: 3 });
    expect(moveRequest(siblings, 25, { after: 20 })).toEqual({ sub_issue_id: 1, after_id: 3 });
  });

  test('an item already in place needs no request', () => {
    expect(moveRequest(siblings, 25, { top: true })).toBeNull();
    expect(moveRequest(siblings, 11, { before: 20 })).toBeNull();
    expect(moveRequest(siblings, 11, { after: 25 })).toBeNull();
  });

  test('unknown items and unclear positions fail', () => {
    expect(() => moveRequest(siblings, 99, { top: true })).toThrow('#99 is not a sub-issue');
    expect(() => moveRequest(siblings, 25, { before: 99 })).toThrow('#99 is not a sub-issue');
    expect(() => moveRequest(siblings, 25, {})).toThrow('exactly one');
    expect(() => moveRequest(siblings, 25, { top: true, after: 20 })).toThrow('exactly one');
  });
});
