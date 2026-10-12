# Briefs, reports and review rounds

Templates for step 5 and step 7 of the orchestrator workflow. Fill every placeholder; write the brief in the owner's language and keep the status words as they are.

## Worker brief

```
You are a worker session, spawned by the orchestrator session <orchestrator sessionId> for the owner.

Issue: #<n> <url>
Worktree: <path>, branch <branch> from origin/dev. Work only there.

Goal: <what is missing and how we know it is done, in a few sentences>

Acceptance: <the issue's criteria, verbatim>

Limits:
- Follow AGENTS.md, docs/workflow.md and the project skills they require.
- Stop after: <draft pull request with the plan | implementation with proof | other>. Do not implement before the owner's approval reaches you through me, quoted.
- Lab: <you may use lab/run | do not use lab/run>. Full builds and test runs: <go ahead | ask me first>.
- Never push to main or dev, mark ready, merge, close issues, or touch other worktrees.

Owner decisions so far: <quoted, with date, or "none">

End every turn with the report below.
```

## Worker report

```
STATUS: DONE | READY | BLOCKED | QUESTION
Changed: <files, commits, pull request>
Evidence: <commands run and their result, CI run, proof links>
Not proven or not run: <list, or "none">
For the owner: <numbered questions, each answerable on its own, or "none">
```

`DONE` means the brief's stop step is reached. `READY` means waiting for a decision, `BLOCKED` names what blocks, `QUESTION` needs an answer before work continues.

## Review round

```
Review round <k> of pull request #<n> (<url>), branch <branch>, worktree <path>.
Read only: do not edit, commit or push.

Original brief: <verbatim>
Diff: git diff origin/dev...<branch>
Prior findings and the author's answers: <list, or "first round">
Open objections: <list, or "none">

Check the acceptance criteria against the code and the proof, correctness, the AGENTS.md rules and the project skills the change requires.

Report each finding with severity (blocking, should, nit), file and line, and the evidence. Say "no blocking findings" explicitly when that is the result.
```
