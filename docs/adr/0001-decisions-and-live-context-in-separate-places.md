# 0001. Decisions and live context in separate places

- Status: Accepted
- Date: 2026-10-02

## Context

PiChamber describes its system in package `README.md` files and module `DOCUMENTATION.md` files, and its rules in `AGENTS.md` and `.agents/skills/`. It has no place for why a decision was made or for what was learned outside the code and is not settled yet. Accepted plans were kept as documents (`docs/plans/github-pull-requests-and-issues.md`, 2026-09-27), which mixes the decision, its reasons and the steps that led to it.

The jira-connector repository (`d102/acsai/jira-connector`, ADR 0001, 2026-09-29) had the same problem: one `CONTEXT.md` mixed settled decisions with open questions within a few days. It split them into decision records and a live context file, and that has held since.

## Decision

- The system stays described where it is: package `README.md` and module `DOCUMENTATION.md` files, with `AGENTS.md` for always-on rules.
- `docs/adr/`: one record per architecture or process decision, in the format of `docs/adr/README.md`. The context of a record carries the evidence and its sources, so nothing is lost when the evidence leaves `CONTEXT.md`. An accepted record is not rewritten; a new record supersedes it.
- `CONTEXT.md`: live context only. Open findings and questions, each with source, date and what will settle it. The pull request that settles an entry, by a record, a document, or code, removes it.

A pull request that makes or changes a decision adds or supersedes a record. Its description names the records under `## Decisions` and the added and removed context under `## Findings`.

## Consequences

- `CONTEXT.md` shrinks as work progresses. Removed entries stay in the Git history and in the squash commit of the pull request that removed them.
- A record is longer than a line in a list, because it must carry its own evidence.
- Repository tests check the record format, the index and the fields of every `CONTEXT.md` entry.

## Revisit when

`CONTEXT.md` keeps growing without entries being settled, or records are edited instead of superseded.
