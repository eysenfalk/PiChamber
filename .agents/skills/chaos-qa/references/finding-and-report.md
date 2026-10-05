# Findings and report

Load before filing an issue or writing the final report.

## Finding versus suspicion

A finding has all of:

- reproduced at least twice from a clean start, with the count (`3 of 3`, `2 of 5`);
- the shortest steps that fail, from a fresh lab or a named host setup;
- expected behavior with its source (acceptance criterion, documented invariant, project rule, or plain user expectation stated as such);
- actual behavior, observed, not inferred;
- evidence: screenshot or short video, console and server log excerpts, probe output.

Anything less is a suspicion. Suspicions go into the report with what was tried and why it did not reproduce.

## Severity

| Severity | Meaning |
|---|---|
| S1 | Data or session loss, security or auth bypass, credentials exposed |
| S2 | A flow is broken or stuck with no workaround inside the app |
| S3 | Wrong or stale state that a reload or retry fixes |
| S4 | Cosmetic, copy, layout |

## Filing

1. Search first: `gh issue list -R eysenfalk/PiChamber --state all --search "<key words>"`. If it exists, add a comment with the new reproduction instead of a new issue.
2. One issue per finding: `gh issue create --label bug --title "<what breaks, where>" --body-file <file>`. Attach media with `gh issue comment --attach`.
3. Body sections: Environment (commit, dirty flag, runtime, launch mode, viewport, theme), Steps, Expected, Actual, Reproduced (count), Evidence, Severity, Suspected cause (hypothesis, optional), Found by (`chaos-qa`, charter, way).
4. No credentials, tokens, pairing codes or real user content in text, logs or media. Lab content is synthetic; host-instance screenshots must show only `$run` data.
5. Do not add the issue to the roadmap and do not close issues.

## Report

Return in chat, in this order:

1. Charter, build under test, way, time used, covered or timebox exhausted.
2. Findings: severity, title, issue link, one line each.
3. Suspicions with what was tried.
4. Way 1: the assumption table (assumption, location, probe, result).
5. Way 2: what was attacked and held, by class from the catalogue.
6. Runtime cells left unchecked.
7. Cleanup state: lab down, instances stopped, evidence path.
