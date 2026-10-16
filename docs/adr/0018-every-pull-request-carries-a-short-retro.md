# 0018. Every pull request carries a short retro

- Status: Accepted
- Date: 2026-10-16

## Context

Review and fix rounds that could have been avoided stay invisible once a pull request is merged, so the same mistakes return. The owner decided in chat with the orchestrator (2026-10-16, issue #227) that every pull request answers a short retro.

## Decision

- The pull request template has a required section `## Retro` with three questions: which review or fix round was avoidable, which check would have found it earlier, and what changes in a rule, skill or test (or explicitly: nothing). Optional: the number of questions asked to the owner in this pull request.
- The answer is written before the hand-over. A draft writes the placeholder "Open until ready".
- The `pull-request` check gets no new logic: it already requires every template section to be filled, so it requires `## Retro` like the others. It does not judge the content, and it does not tell the placeholder from an answer.

## Consequences

- Avoidable rounds are named in every pull request, and what should change in a rule, skill or test is written down where reviewers see it.
- The requirement applies from the first description check after the merge, to every open pull request: a draft adds `## Retro` with "Open until ready", a ready one answers the questions.
- The placeholder passes the check on a ready pull request. Only the reviewer notices it.

## Revisit when

Retros are routinely placeholders or empty answers, or the answers do not lead to any change in rules, skills or tests.
