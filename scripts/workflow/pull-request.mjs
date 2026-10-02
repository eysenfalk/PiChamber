// Checks a pull request against .github/PULL_REQUEST_TEMPLATE.md and the tracker in workflow.json:
// every template section present and filled, an issue referenced, and acceptance criteria as a
// checklist that is fully checked once the pull request leaves draft (docs/workflow.md).

// How the Issue section references a ticket, per tracker type of workflow.json.
const ISSUE_REFERENCE = {
  github: /(^|\s)([\w.-]+\/[\w.-]+)?#\d+\b/,
  gitlab: /(^|\s)#\d+\b/,
  jira: /\b[A-Z][A-Z0-9]+-\d+\b/,
  local: /issues\/\S+\.md/,
};

const CHECKBOX = /^\s*[-*] \[( |x|X)\] (.+)$/gm;

// Template guidance lives in HTML comments; a section holding only a comment is empty.
const withoutComments = (text) => text.replace(/\r\n/g, '\n').replace(/<!--[\s\S]*?-->/g, '');

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const templateSections = (template) =>
  [...withoutComments(template).matchAll(/^## (.+)$/gm)].map((match) => match[1].trim());

/** The text below "## name" up to the next "## " heading, or null when the heading is missing. */
export const section = (description, name) => {
  const heading = new RegExp(`^## ${escapeRegExp(name)}[ \\t]*$([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm');
  const match = withoutComments(description).match(heading);
  return match ? match[1].trim() : null;
};

/**
 * @param {{ title: string, body: string, draft: boolean }} pullRequest
 * @param {string[]} sections headings of the template, in order
 * @param {string} tracker tracker.type of workflow.json
 * @returns {string[]} problems; empty when the pull request follows the workflow
 */
export const checkPullRequest = ({ title, body, draft }, sections, tracker) => {
  const problems = [];
  if (!title.trim()) problems.push('The title is empty.');

  for (const name of sections) {
    const text = section(body, name);
    if (text === null) problems.push(`Section "## ${name}" from the template is missing.`);
    else if (!text) problems.push(`Section "## ${name}" is empty.`);
  }

  const criteria = section(body, 'Acceptance criteria');
  if (criteria) {
    const boxes = [...criteria.matchAll(CHECKBOX)];
    if (boxes.length === 0) {
      problems.push('Section "## Acceptance criteria" needs a checklist ("- [ ] ...").');
    } else if (!draft) {
      for (const [, mark, text] of boxes) {
        if (mark === ' ') problems.push(`Acceptance criterion not checked off: ${text.trim()}`);
      }
    }
  }

  const issue = section(body, 'Issue');
  const reference = ISSUE_REFERENCE[tracker];
  if (issue && !/^none\b/i.test(issue) && !reference?.test(issue)) {
    problems.push(
      `Section "## Issue" names no ${tracker} issue. Write "Closes #12", "Relates to #12", or "None" with a reason.`,
    );
  }
  return problems;
};
