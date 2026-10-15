import { describe, expect, it } from 'vitest';

import { schemaViolation } from './contract-validator.js';
import { reportViolation } from './report-rules.js';
import { ORCHESTRATION_TOOLS, OWNER_QUESTION_EXAMPLE } from './tool-contracts.js';

// A complete owner question and blocker (#210): one decision, understandable
// and answerable from the decision inbox without opening anything else.
const ownerQuestion = () => ({
  kind: 'question',
  audience: 'owner',
  summary: 'Soll der README Check rot werden, wenn der Lizenzabschnitt fehlt?',
  brief: {
    context: 'Ich baue den README Check für das Release (Issue #42). Er prüft heute Titel und Installationsabschnitt; der Lizenzabschnitt fehlt in drei alten Branches. Ich muss jetzt wissen, wie streng er ist, weil davon die Tests abhängen.',
    options: [
      { label: 'Rot werden', consequence: 'Ein Release ohne Lizenz ist blockiert; die drei alten Branches werden sofort rot.', recommended: true },
      { label: 'Nur warnen', consequence: 'Alles bleibt grün; eine fehlende Lizenz fällt erst im Review auf.' },
    ],
    recommendation: 'Rot werden: eine fehlende Lizenz blockiert das Release ohnehin, der Check sagt es nur früher.',
    meanwhile: 'Ich schreibe die Tests für Titel und Installation weiter; der Lizenzteil wartet.',
  },
});

const ownerBlocker = () => ({
  kind: 'blocked',
  audience: 'owner',
  summary: 'Der Lab Nachweis ist blockiert: das Lab gehört einem anderen Worktree.',
  brief: {
    context: 'Für den Nachweis von PR #211 brauche ich das Lab. lab/run status zeigt, dass der Worktree 194-control-center es hält.',
    tried: 'Eine Stunde gewartet und den Integrator per Intercom gefragt; keine Antwort.',
    needed: 'Gib das Lab frei oder sag mir, wann ich es nehmen darf.',
    recommendation: 'Den Integrator fragen, ob er bis 18 Uhr fertig ist; sonst das Lab nach seinem Lauf übernehmen.',
    meanwhile: 'Ich mache die Unit Tests fertig; Aufnahme und Veröffentlichung warten.',
  },
});

const without = (report, field) => {
  const { [field]: _omitted, ...brief } = report.brief;
  return { ...report, brief };
};

describe('worker report rules', () => {
  it('keeps the rules per kind', () => {
    expect(reportViolation({ kind: 'done', summary: 'x', noPullRequest: 'none' })).toMatch(/evidence/);
    expect(reportViolation({ kind: 'done', summary: 'x', evidence: ['tests'] })).toMatch(/pullRequest or noPullRequest/);
    expect(reportViolation({ kind: 'ready', summary: 'x' })).toMatch(/pullRequest/);
    expect(reportViolation({ kind: 'question', summary: 'x' })).toMatch(/audience/);
    expect(reportViolation({ kind: 'progress', summary: 'x', brief: { recommendation: 'y' } })).toMatch(/brief/);
    expect(reportViolation({ kind: 'progress', summary: 'x' })).toBeNull();
  });

  it('accepts the example the worker_report description shows', () => {
    const workerReport = ORCHESTRATION_TOOLS.find((tool) => tool.name === 'worker_report');
    expect(workerReport.description).toContain(JSON.stringify(OWNER_QUESTION_EXAMPLE));
    expect(schemaViolation(workerReport.parameters, OWNER_QUESTION_EXAMPLE)).toBeNull();
    expect(reportViolation(OWNER_QUESTION_EXAMPLE)).toBeNull();
  });

  it('accepts a complete owner question and a complete owner blocker', () => {
    expect(reportViolation(ownerQuestion())).toBeNull();
    expect(reportViolation(ownerBlocker())).toBeNull();
  });

  it('leaves questions for the orchestrator free, with or without a brief', () => {
    expect(reportViolation({ kind: 'question', audience: 'orchestrator', summary: 'Which branch?' })).toBeNull();
    expect(reportViolation({ kind: 'blocked', audience: 'orchestrator', summary: 'Lab held', brief: { recommendation: 'wait' } })).toBeNull();
  });

  it('refuses an owner question or blocker without a brief', () => {
    expect(reportViolation({ ...ownerQuestion(), brief: undefined })).toMatch(/brief/);
    expect(reportViolation({ ...ownerBlocker(), brief: undefined })).toMatch(/brief/);
  });

  it('names every missing part of an owner question at once', () => {
    const message = reportViolation({ ...ownerQuestion(), brief: { recommendation: 'Rot werden.' } });
    expect(message).toMatch(/brief\.context/);
    expect(message).toMatch(/brief\.options/);
    expect(message).toMatch(/brief\.meanwhile/);
  });

  it('needs context and meanwhile for an owner question', () => {
    expect(reportViolation(without(ownerQuestion(), 'context'))).toMatch(/brief\.context/);
    expect(reportViolation(without(ownerQuestion(), 'meanwhile'))).toMatch(/brief\.meanwhile/);
  });

  it('needs at least two options, each with a consequence, distinct labels and exactly one recommended', () => {
    const withOptions = (options) => ({ ...ownerQuestion(), brief: { ...ownerQuestion().brief, options } });
    const [first, second] = ownerQuestion().brief.options;
    expect(reportViolation(withOptions([first]))).toMatch(/at least two/);
    expect(reportViolation(withOptions([first, { label: second.label }]))).toMatch(/brief\.options\[1\]\.consequence/);
    expect(reportViolation(withOptions([first, { ...second, label: first.label }]))).toMatch(/distinct/);
    expect(reportViolation(withOptions([{ ...first, recommended: false }, second]))).toMatch(/recommended/);
    expect(reportViolation(withOptions([first, { ...second, recommended: true }]))).toMatch(/recommended/);
  });

  it('keeps an owner question to one line, one decision', () => {
    expect(reportViolation({ ...ownerQuestion(), summary: 'Lizenz pflicht?\nUnd der CHANGELOG?' })).toMatch(/one line/);
  });

  it('needs what was tried and what is needed for an owner blocker; its options are optional', () => {
    expect(reportViolation(without(ownerBlocker(), 'tried'))).toMatch(/brief\.tried/);
    expect(reportViolation(without(ownerBlocker(), 'needed'))).toMatch(/brief\.needed/);
    expect(reportViolation(without(ownerBlocker(), 'context'))).toMatch(/brief\.context/);
    expect(reportViolation(without(ownerBlocker(), 'meanwhile'))).toMatch(/brief\.meanwhile/);
    const [first] = ownerQuestion().brief.options;
    expect(reportViolation({ ...ownerBlocker(), brief: { ...ownerBlocker().brief, options: [first] } })).toMatch(/at least two/);
  });

  it('takes tried and needed only on a blocker', () => {
    expect(reportViolation({ ...ownerQuestion(), brief: { ...ownerQuestion().brief, tried: 'x' } })).toMatch(/brief\.tried/);
  });
});
