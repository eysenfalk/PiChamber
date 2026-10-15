// Rules `worker_report` checks beyond its schema (tool-contracts.js), per
// kind. A question or blocker for the owner must be answerable from the
// decision inbox alone (#210, ADR 0017): the daemon refuses an incomplete one
// and names everything that is missing at once, so one retry suffices.

const filled = (value) => typeof value === 'string' && value.trim() !== '';

// What a set of options lacks: at least two, each with a consequence,
// distinct labels, exactly one recommended.
const optionProblems = (options) => {
  if (!Array.isArray(options) || options.length < 2) {
    return ['brief.options needs at least two options, each with label and consequence, exactly one recommended'];
  }
  const problems = [];
  options.forEach((option, index) => {
    if (!filled(option.consequence)) problems.push(`brief.options[${index}].consequence is missing`);
  });
  const labels = options.map((option) => option.label.trim().toLowerCase());
  if (new Set(labels).size !== labels.length) problems.push('brief.options needs distinct labels');
  const recommended = options.filter((option) => option.recommended === true).length;
  if (recommended !== 1) problems.push(`brief.options needs exactly one recommended option, not ${recommended}`);
  return problems;
};

// What an owner question or blocker lacks; empty when it is complete.
const ownerBriefProblems = (args) => {
  const brief = args.brief ?? {};
  const problems = [];
  if (/[\r\n]/.test(args.summary)) problems.push('summary must be one line: the one decision or the blocker');
  if (!filled(brief.context)) problems.push('brief.context is missing');
  if (args.kind === 'question' || brief.options !== undefined) problems.push(...optionProblems(brief.options));
  if (!filled(brief.recommendation)) problems.push('brief.recommendation is missing');
  if (!filled(brief.meanwhile)) problems.push('brief.meanwhile is missing');
  if (args.kind === 'blocked') {
    if (!filled(brief.tried)) problems.push('brief.tried is missing');
    if (!filled(brief.needed)) problems.push('brief.needed is missing');
  }
  return problems;
};

/** The first rule `args` of a worker_report break, as a message, or null. */
export const reportViolation = (args) => {
  if (args.kind === 'done' && !args.evidence?.length) return 'A done report needs evidence.';
  if (args.kind === 'done' && args.pullRequest === undefined && args.noPullRequest === undefined) {
    return 'A done report needs pullRequest or noPullRequest.';
  }
  if (args.kind === 'ready' && args.pullRequest === undefined) return 'A ready report needs pullRequest.';
  if ((args.kind === 'question' || args.kind === 'blocked') && !args.audience) return `A ${args.kind} report needs audience.`;
  if (args.brief && args.kind !== 'question' && args.kind !== 'blocked') return 'Only a question or blocked report has a brief.';
  if (args.kind !== 'blocked' && (args.brief?.tried !== undefined || args.brief?.needed !== undefined)) {
    return 'Only a blocked report has brief.tried and brief.needed.';
  }
  if (args.audience === 'owner') {
    const problems = ownerBriefProblems(args);
    if (problems.length) {
      const what = args.kind === 'blocked' ? 'blocker' : 'question';
      return `An owner ${what} must be answerable from the decision inbox alone: ${problems.join('; ')}.`;
    }
  }
  return null;
};
