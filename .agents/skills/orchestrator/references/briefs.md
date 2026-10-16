# Briefs, reports and review rounds

Templates for step 5 and step 7 of the orchestrator workflow. Fill every placeholder; write the brief in the owner's language and keep the status words as they are.

## Worker brief

```
You are a worker session, spawned by the orchestrator session <orchestrator sessionId> for the owner.

Issue: #<n> <url>
Worktree: <path>, branch <branch> from origin/dev. Work only there.
Role: <role; for a task-* its level and the one line reason from the When column>

Goal: <what is missing and how we know it is done, in a few sentences>

Acceptance: <the issue's criteria, verbatim>

Limits:
- Follow AGENTS.md, docs/workflow.md and the project skills they require.
- Lane: <fast | slow>, with the reason (docs/workflow.md). Fast: build right away. Slow: do not write production code before the owner's go reaches you through me, quoted. A worker may move to slow, never to fast.
- Stop after: <draft pull request with the plan | implementation with proof | other>.
- Lab: <you may use lab/run | do not use lab/run>. Full builds and test runs: <go ahead | ask me first>.
- Subagents: <allowed | not allowed>. Without this line the worker decides itself.
- Never push to main or dev, mark ready, merge, close issues, or touch other worktrees.
- If the work proves harder or larger than this brief says, or a bug will not give way, stop and report QUESTION instead of guessing.

Owner decisions so far: <quoted, with date, or "none">

End every turn with the report below.
```

## Worker report

```
STATUS: DONE | READY | BLOCKED | QUESTION
Changed: <files, commits, pull request>
Evidence: <commands run and their result, CI run, proof links>
Not proven or not run: <list, or "none">
For the owner: <the id of the open owner question or blocker, or "none">
```

`DONE` means the brief's stop step is reached. `READY` means waiting for a decision, `BLOCKED` names what blocks, `QUESTION` needs an answer before work continues.

## Owner questions and blockers

A question or blocker for the owner reaches the decision inbox of the control center, where the owner reads it without the worker's chat and answers by tapping an option or by typing. It is one decision, in the owner's language, understandable on its own: no internal shorthand (slice or step codes, abbreviations from the chat) the owner has not seen. Workers send it through `worker_report` with `audience: owner` and a full `brief`, and the daemon refuses an incomplete one; the orchestrator asks its own owner questions in the same form in its chat.

- `summary`: the decision or the blocker, one line.
- `context`: what the work is, where it stands, why the decision is needed now; for a blocker its cause.
- `options`: at least two answers, each with its `consequence`, exactly one `recommended`. Optional for a blocker.
- `recommendation`: which option and why. `counterargument` and `revisit` when they help.
- `meanwhile`: what the worker does, or what stays blocked, until the answer.
- Blocker only: `tried` (what was tried) and `needed` (what the worker needs from whoever answers).

The next decision is asked after this one is answered, not in the same report.

Question:

```json
{
  "kind": "question",
  "audience": "owner",
  "summary": "Soll der README Check rot werden, wenn der Lizenzabschnitt fehlt?",
  "brief": {
    "context": "Ich baue den README Check für das Release (Issue #42). Er prüft heute Titel und Installationsabschnitt; drei alte Branches haben keinen Lizenzabschnitt. Wie streng er ist, entscheidet, welche Tests ich jetzt schreibe.",
    "options": [
      { "label": "Rot werden", "consequence": "Ein Release ohne Lizenz ist blockiert; die drei alten Branches werden sofort rot.", "recommended": true },
      { "label": "Nur warnen", "consequence": "Alles bleibt grün; eine fehlende Lizenz fällt erst im Review auf." }
    ],
    "recommendation": "Rot werden: eine fehlende Lizenz blockiert das Release ohnehin, der Check sagt es nur früher.",
    "counterargument": "Die drei alten Branches brauchen dann sofort einen Lizenzabschnitt.",
    "meanwhile": "Ich schreibe die Tests für Titel und Installation weiter; der Lizenzteil wartet."
  }
}
```

Blocker:

```json
{
  "kind": "blocked",
  "audience": "owner",
  "summary": "Der Lab Nachweis für PR #211 ist blockiert: das Lab gehört einem anderen Worktree.",
  "brief": {
    "context": "Für den Nachweis brauche ich das Lab (eins pro Rechner). lab/run status zeigt, dass der Worktree 194-control-center es hält.",
    "tried": "Eine Stunde gewartet und den Integrator von #194 per Intercom gefragt; keine Antwort.",
    "needed": "Gib das Lab frei oder sag mir, wann ich es nehmen darf.",
    "recommendation": "Den Integrator fragen, ob er bis 18 Uhr fertig ist; sonst das Lab nach seinem Lauf übernehmen.",
    "meanwhile": "Ich mache die Unit Tests fertig; Aufnahme und Veröffentlichung warten."
  }
}
```

## Review round

```
Review round <1 | 2> of pull request #<n> (<url>), branch <branch>, worktree <path>.
Read only: do not edit, commit or push.

Original brief: <verbatim>
Diff: git diff origin/dev...<branch>
Prior findings and the author's answers: <list, or "first round">
Open objections: <list, or "none">

Round 1: check the acceptance criteria against the code and the proof, correctness, the AGENTS.md rules and the project skills the change requires.
Round 2: only check whether the findings of round 1 are closed; raise nothing new.

No overengineering: a finding is blocking only when it causes a real problem that affects the user. Name anything else as known limit or follow-up issue.

Report each finding with severity (blocking, should, nit), file and line, the evidence, and for blocking the user effect. Say "no blocking findings" explicitly when that is the result.
```
