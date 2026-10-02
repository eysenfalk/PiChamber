import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { checkPullRequest, section, templateSections } from './pull-request.mjs';

const template = readFileSync(new URL('../../.github/PULL_REQUEST_TEMPLATE.md', import.meta.url), 'utf8');
const SECTIONS = templateSections(template);

const filled = (overrides = {}) =>
  SECTIONS.map((name) => {
    if (name in overrides) return overrides[name] === null ? '' : `## ${name}\n\n${overrides[name]}\n`;
    if (name === 'Issue') return `## ${name}\n\nCloses #9\n`;
    if (name === 'Acceptance criteria') return `## ${name}\n\n- [x] Done and proven.\n- [ ] Still open.\n`;
    return `## ${name}\n\nText.\n`;
  }).join('\n');

const check = (body, draft = true) => checkPullRequest({ title: 'A change', body, draft }, SECTIONS, 'github');

describe('the pull request template', () => {
  test('has the sections of the workflow, in order', () => {
    expect(SECTIONS).toEqual([
      'Issue',
      'Goal',
      'Acceptance criteria',
      'Approach',
      'Affected surfaces',
      'Repository guidance',
      'Verification',
      'Decisions',
      'Findings',
      'Out of scope',
      'Risks and open questions',
    ]);
  });

  test('is not a valid description by itself, because its sections hold only guidance', () => {
    expect(check(template)).toContain('Section "## Goal" is empty.');
  });
});

describe('a pull request description', () => {
  test('passes as a draft with open acceptance criteria', () => {
    expect(check(filled())).toEqual([]);
  });

  test('fails once it leaves draft with an open acceptance criterion', () => {
    expect(check(filled(), false)).toEqual(['Acceptance criterion not checked off: Still open.']);
  });

  test('passes out of draft when every criterion is checked off', () => {
    const body = filled({ 'Acceptance criteria': '- [x] One.\n- [X] Two.' });
    expect(check(body, false)).toEqual([]);
  });

  test('fails without a checklist of acceptance criteria', () => {
    expect(check(filled({ 'Acceptance criteria': 'It works.' }))).toEqual([
      'Section "## Acceptance criteria" needs a checklist ("- [ ] ...").',
    ]);
  });

  test('fails when a template section is missing or holds only a comment', () => {
    expect(check(filled({ Findings: null }))).toEqual(['Section "## Findings" from the template is missing.']);
    expect(check(filled({ Decisions: '<!-- Records in docs/adr/, or "None". -->' }))).toEqual([
      'Section "## Decisions" is empty.',
    ]);
  });

  test('needs an issue reference, or None with a reason', () => {
    expect(check(filled({ Issue: 'The workflow issue' }))).toEqual([
      'Section "## Issue" names no github issue. Write "Closes #12", "Relates to #12", or "None" with a reason.',
    ]);
    expect(check(filled({ Issue: 'Relates to eysenfalk/PiChamber#2' }))).toEqual([]);
    expect(check(filled({ Issue: 'None: a typo in a comment.' }))).toEqual([]);
  });

  test('fails with an empty title', () => {
    expect(checkPullRequest({ title: ' ', body: filled(), draft: true }, SECTIONS, 'github')).toEqual([
      'The title is empty.',
    ]);
  });

  test('is read the same with Windows line endings, as the GitHub web editor writes them', () => {
    expect(check(filled().replace(/\n/g, '\r\n'), false)).toEqual(['Acceptance criterion not checked off: Still open.']);
  });
});

describe('section', () => {
  test('reads the last section up to the end and stops at the next heading', () => {
    const body = '## Goal\n\nFirst.\n\n### Detail\n\nMore.\n## Out of scope\n\nLast.';
    expect(section(body, 'Goal')).toBe('First.\n\n### Detail\n\nMore.');
    expect(section(body, 'Out of scope')).toBe('Last.');
    expect(section(body, 'Risks and open questions')).toBeNull();
  });
});
