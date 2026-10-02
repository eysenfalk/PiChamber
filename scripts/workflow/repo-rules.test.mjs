import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import {
  adrIndexProblems,
  adrRecordProblems,
  contextEntries,
  contextProblems,
  workflowConfigProblems,
} from './repo-rules.mjs';

const root = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

const adrRecords = () =>
  Object.fromEntries(
    readdirSync(new URL('docs/adr/', root))
      .filter((name) => name.endsWith('.md') && name !== 'README.md')
      .map((name) => [name, read(`docs/adr/${name}`)]),
  );

describe('this repository', () => {
  test('every decision record follows the format of docs/adr/README.md', () => {
    expect(Object.entries(adrRecords()).flatMap(([name, text]) => adrRecordProblems(name, text))).toEqual([]);
  });

  test('the decision record index lists every record with its status', () => {
    expect(adrIndexProblems(adrRecords(), read('docs/adr/README.md'))).toEqual([]);
  });

  test('every CONTEXT.md entry names its source, its date and what settles it', () => {
    expect(contextProblems(read('CONTEXT.md'))).toEqual([]);
  });

  test('workflow.json names a tracker with its settings and where plans go', () => {
    expect(workflowConfigProblems(JSON.parse(read('workflow.json')), existsSync(new URL('PLAN.md', root)))).toEqual([]);
  });
});

const GOOD =
  '# 0001. Keep it\n\n- Status: Accepted\n- Date: 2026-10-02\n\n' +
  '## Context\n\nWhy.\n\n## Decision\n\nWhat.\n\n## Consequences\n\nThen.\n\n## Revisit when\n\nLater.\n';

describe('decision records', () => {
  test('a complete record passes', () => {
    expect(adrRecordProblems('0001-keep-it.md', GOOD)).toEqual([]);
  });

  test('a record without Revisit when fails', () => {
    expect(adrRecordProblems('0001-keep-it.md', GOOD.replace('## Revisit when\n\nLater.\n', ''))).toEqual([
      "0001-keep-it.md: section '## Revisit when' is missing or empty",
    ]);
  });

  test('an unknown status fails, and Proposed needs Waits for', () => {
    expect(adrRecordProblems('0001-keep-it.md', GOOD.replace('Accepted', 'Maybe'))).toEqual([
      '0001-keep-it.md: status must be Proposed, Accepted or Superseded by NNNN',
    ]);
    expect(adrRecordProblems('0001-keep-it.md', GOOD.replace('Accepted', 'Proposed'))).toEqual([
      "0001-keep-it.md: a Proposed record needs a 'Waits for' line",
    ]);
    expect(adrRecordProblems('0001-keep-it.md', GOOD.replace('Accepted', 'Superseded by 0007'))).toEqual([]);
  });

  test('title and file name must agree', () => {
    expect(adrRecordProblems('0002-keep-it.md', GOOD)).toEqual(["0002-keep-it.md: title must start with '# 0002. '"]);
    expect(adrRecordProblems('keep-it.md', GOOD)).toEqual(['keep-it.md: file name must be NNNN-short-title.md']);
  });

  test('gaps, missing index rows, unknown files and wrong statuses fail', () => {
    const found = { '0001-a.md': GOOD, '0003-c.md': GOOD.replace('Accepted', 'Proposed') };
    const index = '| [0001](0001-a.md) | A | Accepted |\n| [0003](0003-c.md) | C | Accepted |\n| [0004](0004-d.md) | D | Accepted |\n';
    expect(adrIndexProblems(found, index)).toEqual([
      'numbers must run from 0001 without gaps: 1, 3',
      '0003-c.md: index says Accepted, record says Proposed',
      'index lists 0004-d.md, which does not exist',
    ]);
    expect(adrIndexProblems({ '0001-a.md': GOOD }, '')).toEqual(['0001-a.md is missing in the index']);
  });
});

describe('CONTEXT.md entries', () => {
  test('are the ### headings', () => {
    expect([...contextEntries('# Context\n\n## Topic\n\n### One\n\nA.\n\n### Two\n\nB.\n').keys()]).toEqual(['One', 'Two']);
  });

  test('an entry without Settled by fails', () => {
    expect(contextProblems('## Fork\n\n### Actions\n\n- Source: gh run list\n- Date: 2026-10-02\n\nText.\n')).toEqual([
      "Actions: 'Settled by' is missing",
    ]);
  });

  test('a date in another format fails', () => {
    expect(contextProblems('### Actions\n\n- Source: gh\n- Date: 02.10.2026\n- Settled by: a run\n')).toEqual([
      'Actions: date must be YYYY-MM-DD',
    ]);
  });
});

describe('workflow.json', () => {
  test('a GitHub tracker needs its repository', () => {
    expect(workflowConfigProblems({ tracker: { type: 'github' }, plans: 'pull-request' }, false)).toEqual([
      'tracker.repo is required for tracker.type github',
    ]);
  });

  test('a local tracker keeps its plan in PLAN.md, and PLAN.md exists exactly then', () => {
    expect(workflowConfigProblems({ tracker: { type: 'local', dir: 'issues' }, plans: 'pull-request' }, false)).toEqual([
      'a local tracker needs plans: file',
    ]);
    expect(workflowConfigProblems({ tracker: { type: 'local', dir: 'issues' }, plans: 'file' }, true)).toEqual([]);
    expect(workflowConfigProblems({ tracker: { type: 'github', repo: 'a/b' }, plans: 'pull-request' }, true)).toEqual([
      'PLAN.md must exist exactly when plans is file',
    ]);
  });

  test('an unknown tracker or plan place fails', () => {
    expect(workflowConfigProblems({ tracker: { type: 'trello' }, plans: 'wiki' }, false)).toEqual([
      'tracker.type must be one of github, gitlab, jira, local',
      'plans must be pull-request or file',
    ]);
  });
});
