# Decision records

One record per architecture or process decision: why it was made, what was decided, what follows from it and when to look at it again. The system itself is described in the package `README.md` and module `DOCUMENTATION.md` files; open questions that are not decided yet are in [CONTEXT.md](../../CONTEXT.md). Why decisions live here: [0001](0001-decisions-and-live-context-in-separate-places.md).

## Index

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-decisions-and-live-context-in-separate-places.md) | Decisions and live context in separate places | Accepted |
| [0002](0002-workflow-from-jira-connector.md) | Workflow from jira-connector: plans in draft pull requests, proof before merge | Accepted |

## Rules

- File name `NNNN-short-title.md`, numbered without gaps; the title starts with the same number.
- **Status** is one of:
  - `Proposed`: we work with it, but a confirmation is missing. A `Waits for` line names it.
  - `Accepted`: in force.
  - `Superseded by NNNN`: replaced by a newer record, which names this one in its context.
- An accepted record is not rewritten. To change a decision, write a new record and set the old one to `Superseded by`. Fixing a typo or a broken link is fine.
- The context carries the evidence with its sources and dates. Evidence that settles an entry in `CONTEXT.md` moves here, and the entry is removed.
- The index above lists every record with its current status.

`scripts/workflow/repo-rules.test.mjs` checks all of these rules except the one on rewriting.

## Template

```markdown
# NNNN. Decision in a few words

- Status: Proposed
- Date: YYYY-MM-DD
- Waits for: who has to confirm what (only while Proposed)

## Context

The forces behind the decision: requirements, constraints, measurements, alternatives.
Every fact with its source and date.

## Decision

What we do, stated as rules.

## Consequences

What becomes easier, harder or necessary because of it.

## Revisit when

The observable condition under which this decision must be looked at again.
```
