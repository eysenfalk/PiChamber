// Checks the pull request of the current GitHub Actions event against the template and workflow.json.
//
//   GITHUB_EVENT_PATH=<event.json> node scripts/workflow/check-pr.mjs
//
// The event file is the pull_request event payload; GitHub Actions sets GITHUB_EVENT_PATH.
import { readFileSync } from 'node:fs';
import { checkPullRequest, templateSections } from './pull-request.mjs';

const root = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

const eventPath = process.env.GITHUB_EVENT_PATH;
if (!eventPath) {
  console.error('GITHUB_EVENT_PATH is not set; it must point to a pull_request event payload.');
  process.exit(2);
}
const pullRequest = JSON.parse(readFileSync(eventPath, 'utf8')).pull_request;
if (!pullRequest) {
  console.error(`${eventPath} is not a pull_request event.`);
  process.exit(2);
}

const problems = checkPullRequest(
  { title: pullRequest.title ?? '', body: pullRequest.body ?? '', draft: pullRequest.draft === true },
  templateSections(read('.github/PULL_REQUEST_TEMPLATE.md')),
  JSON.parse(read('workflow.json')).tracker.type,
);
if (problems.length > 0) {
  console.error(problems.map((problem) => `- ${problem}`).join('\n'));
  process.exit(1);
}
console.log('Pull request title and description follow the template.');
