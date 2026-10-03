// Keeps the roadmap issue of docs/workflow.md current and changes its order.
//
//   node scripts/workflow/roadmap-sync.mjs sync
//   node scripts/workflow/roadmap-sync.mjs add <issue> [--parent <issue>]
//   node scripts/workflow/roadmap-sync.mjs move <issue> (--top | --before <issue> | --after <issue>) [--parent <issue>]
//
// The repository and the roadmap issue come from workflow.json. GitHub is reached through the gh CLI
// and its login; in GitHub Actions, GH_TOKEN is set. add and move regenerate the roadmap issue after.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { LABEL, loadRoadmap, moveRequest, renderRoadmap, replaceGenerated } from './roadmap.mjs';

const USAGE = `Usage:
  roadmap-sync.mjs sync
  roadmap-sync.mjs add <issue> [--parent <issue>]
  roadmap-sync.mjs move <issue> (--top | --before <issue> | --after <issue>) [--parent <issue>]`;

const usage = (message) => {
  console.error(`${message}\n${USAGE}`);
  process.exit(2);
};

const config = JSON.parse(readFileSync(new URL('../../workflow.json', import.meta.url), 'utf8'));
const { type, repo, roadmap } = config.tracker ?? {};
if (type !== 'github' || !repo || !Number.isInteger(roadmap)) {
  usage('workflow.json needs tracker.type github with tracker.repo and tracker.roadmap.');
}

const api = (path, method = 'GET', body) => {
  const args = ['api', '--method', method, '-H', 'X-GitHub-Api-Version: 2022-11-28', `repos/${repo}/${path}`];
  if (body) args.push('--input', '-');
  const output = execFileSync('gh', args, {
    input: body ? JSON.stringify(body) : undefined,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  return output.trim() ? JSON.parse(output) : null;
};
const get = (path) => api(path);

const issueNumber = (value, name) => {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) usage(`${name} must be an issue number, got ${value}.`);
  return number;
};

const sync = () => {
  const { items, unplaced } = loadRoadmap(get, roadmap);
  const issue = get(`issues/${roadmap}`);
  const current = (issue.body ?? '').replace(/\r\n/g, '\n');
  const body = replaceGenerated(current, renderRoadmap({ items, unplaced }));
  if (body === current) {
    console.log(`#${roadmap} is current.`);
    return;
  }
  api(`issues/${roadmap}`, 'PATCH', { body });
  console.log(`#${roadmap} updated: ${items.length} open items, ${unplaced.length} not placed.`);
};

const add = (number, parent) => {
  const issue = get(`issues/${number}`);
  if (issue.pull_request) usage(`#${number} is a pull request, not an issue.`);
  api(`issues/${number}/labels`, 'POST', { labels: [LABEL] });
  // replace_parent moves an issue that already has another parent.
  api(`issues/${parent}/sub_issues`, 'POST', { sub_issue_id: issue.id, replace_parent: true });
  console.log(`#${number} added to #${parent}.`);
};

const move = (number, parent, position) => {
  const siblings = get(`issues/${parent}/sub_issues?per_page=100`);
  const request = moveRequest(siblings, number, position);
  if (!request) {
    console.log(`#${number} is already there.`);
    return;
  }
  api(`issues/${parent}/sub_issues/priority`, 'PATCH', request);
  console.log(`#${number} moved in #${parent}.`);
};

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      parent: { type: 'string' },
      top: { type: 'boolean' },
      before: { type: 'string' },
      after: { type: 'string' },
    },
  });
} catch (error) {
  usage(error.message);
}
const [command, target] = parsed.positionals;
const { values } = parsed;
const parent = values.parent === undefined ? roadmap : issueNumber(values.parent, '--parent');

try {
  if (command === 'sync') {
    sync();
  } else if (command === 'add') {
    add(issueNumber(target, 'The issue'), parent);
    sync();
  } else if (command === 'move') {
    move(issueNumber(target, 'The issue'), parent, {
      top: values.top,
      before: values.before === undefined ? undefined : issueNumber(values.before, '--before'),
      after: values.after === undefined ? undefined : issueNumber(values.after, '--after'),
    });
    sync();
  } else {
    usage(command ? `Unknown command ${command}.` : 'No command given.');
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
