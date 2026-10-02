// Repository rules of docs/workflow.md: decision records (docs/adr/README.md), live context
// (CONTEXT.md) and the workflow configuration (workflow.json). repo-rules.test.mjs applies them.

const ADR_SECTIONS = ['Context', 'Decision', 'Consequences', 'Revisit when'];
const ADR_STATUS = /^(Proposed|Accepted|Superseded by \d{4})$/;
const ADR_NAME = /^(\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const CONTEXT_FIELDS = ['Source', 'Date', 'Settled by'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Settings each tracker type of workflow.json needs.
const TRACKER_SETTINGS = {
  github: ['repo'],
  gitlab: ['url', 'project'],
  jira: ['url', 'project'],
  local: ['dir'],
};

const field = (text, name) => text.match(new RegExp(`^- ${name}: (.*)$`, 'm'))?.[1].trim();

export const adrRecordProblems = (name, text) => {
  const number = name.match(ADR_NAME)?.[1];
  if (!number) return [`${name}: file name must be NNNN-short-title.md`];
  const problems = [];
  if (!text.startsWith(`# ${number}. `)) problems.push(`${name}: title must start with '# ${number}. '`);
  const status = field(text, 'Status');
  if (!status || !ADR_STATUS.test(status)) {
    problems.push(`${name}: status must be Proposed, Accepted or Superseded by NNNN`);
  } else if (status === 'Proposed' && !field(text, 'Waits for')) {
    problems.push(`${name}: a Proposed record needs a 'Waits for' line`);
  }
  if (!DATE.test(field(text, 'Date') ?? '')) problems.push(`${name}: date must be YYYY-MM-DD`);
  for (const heading of ADR_SECTIONS) {
    if (!new RegExp(`^## ${heading}\\n+[^#\\s]`, 'm').test(text)) {
      problems.push(`${name}: section '## ${heading}' is missing or empty`);
    }
  }
  return problems;
};

/** @param {Record<string, string>} records file name to text, without README.md */
export const adrIndexProblems = (records, index) => {
  const problems = [];
  const numbers = Object.keys(records)
    .filter((name) => ADR_NAME.test(name))
    .map((name) => Number(name.slice(0, 4)))
    .sort((a, b) => a - b);
  if (numbers.some((number, position) => number !== position + 1)) {
    problems.push(`numbers must run from 0001 without gaps: ${numbers.join(', ')}`);
  }
  const listed = new Map(
    [...index.matchAll(/^\| \[(\d{4})\]\(([^)]+)\) \|.*\| ([^|]+) \|$/gm)].map((match) => [match[2], match[3].trim()]),
  );
  for (const [name, text] of Object.entries(records).sort(([a], [b]) => a.localeCompare(b))) {
    const status = field(text, 'Status');
    if (!listed.has(name)) problems.push(`${name} is missing in the index`);
    else if (status && listed.get(name) !== status) {
      problems.push(`${name}: index says ${listed.get(name)}, record says ${status}`);
    }
  }
  for (const name of listed.keys()) {
    if (!(name in records)) problems.push(`index lists ${name}, which does not exist`);
  }
  return problems;
};

/** Entries are the "### " headings of CONTEXT.md with their text up to the next heading. */
export const contextEntries = (text) => {
  const parts = text.split(/^(#{1,3} .+)$/m);
  const entries = new Map();
  for (let i = 1; i < parts.length; i += 2) {
    if (parts[i].startsWith('### ')) entries.set(parts[i].slice(4).trim(), parts[i + 1]);
  }
  return entries;
};

export const contextProblems = (text) => {
  const problems = [];
  for (const [title, body] of contextEntries(text)) {
    for (const name of CONTEXT_FIELDS) {
      if (!field(body, name)) problems.push(`${title}: '${name}' is missing`);
    }
    const date = field(body, 'Date');
    if (date && !DATE.test(date)) problems.push(`${title}: date must be YYYY-MM-DD`);
  }
  return problems;
};

/**
 * @param {any} config parsed workflow.json
 * @param {boolean} planFileExists whether PLAN.md exists in the repository root
 */
export const workflowConfigProblems = (config, planFileExists) => {
  const problems = [];
  const tracker = config?.tracker ?? {};
  const settings = TRACKER_SETTINGS[tracker.type];
  if (!settings) problems.push(`tracker.type must be one of ${Object.keys(TRACKER_SETTINGS).join(', ')}`);
  for (const name of settings ?? []) {
    if (!tracker[name]) problems.push(`tracker.${name} is required for tracker.type ${tracker.type}`);
  }
  if (!['pull-request', 'file'].includes(config?.plans)) problems.push('plans must be pull-request or file');
  if (tracker.type === 'local' && config?.plans !== 'file') problems.push('a local tracker needs plans: file');
  if (planFileExists !== (config?.plans === 'file')) problems.push('PLAN.md must exist exactly when plans is file');
  return problems;
};
