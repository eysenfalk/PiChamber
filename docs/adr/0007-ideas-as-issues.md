# 0007. Ideas as records of their own, kept as issues of the tracker

- Status: Proposed
- Date: 2026-10-05
- Waits for: the owner confirming the record in the pull request for #84

## Context

ADR 0003 keeps ideas as one line each in the roadmap issue and makes an idea an issue only when it is about to be worked on. The reason given there was that quick issues without text (#14, #17, #18, #22, #23) filled the issue list and the owner wanted as few issues as possible. Those five were closed on 2026-10-03 and became lines under Ideas in #24.

Since then the owner has decided otherwise:

- 2026-10-04, while grilling the intent model of #74: issues are ideas and reminders, and there may be hundreds of them. The roadmap sets order and dependencies. Work happens in a draft pull request, which is the plan; one issue can lead to several pull requests.
- 2026-10-05, on point 2 of the review on #75: an idea is more than a GitHub issue. It is a record of its own and can come from several sources: an issue, a note, a voice note, a conversation. Where GitHub is available the idea is kept there by default, otherwise in GitLab, otherwise locally, and every one of these places is a valid source.

ADR 0006 defines intents and refers to this record for ideas. An idea is something that could be done; an intent is the will to carry something out.

What already exists, checked on 2026-10-05 in this repository: `workflow.json` names the tracker, with the types `github`, `gitlab`, `jira` and `local` (`scripts/workflow/repo-rules.mjs`); a `local` tracker keeps tickets as Markdown files in `tracker.dir`. Roadmap items are recognized by the label `roadmap`, and `roadmap-sync.mjs` reads only the sub-issues of the roadmap issue, so issues without the label do not appear in the order or the graph.

Alternatives considered:

- **Keep ideas as lines in the roadmap issue** (ADR 0003): one line has no room for a source, a discussion or links, cannot be linked from a session, and only exists on GitHub.
- **A new idea store in PiChamber**: needs its own storage, sync and interface before a single idea is kept, and duplicates what the tracker already does.

## Decision

- **An idea is a record of its own.** It says what could be done and where it came from: an issue, a note, a voice note, a conversation or a session, linked where possible.
- **Where ideas are kept.** In the tracker named by `workflow.json`: as an issue where it is GitHub, as an issue where it is GitLab, as a Markdown file in `tracker.dir` where it is local. Issues and local idea files are both valid sources; a tool that lists ideas reads every place it has access to.
- **Ideas and roadmap items.** An open issue without the label `roadmap` is an idea, unless it is a bug that needs doing now (ADR 0003). It becomes a roadmap item when it is labeled `roadmap` and placed in the roadmap issue (ADR 0003), usually with `roadmap-sync.mjs add`; before work starts it gets a problem and acceptance as before.
- **Ideas and intents.** Working on an idea is an intent (ADR 0006). An intent does not need an idea, and an idea may never become an intent.
- **Many ideas are fine.** Ideas cost nothing to write down. The roadmap, not the issue list, says what is planned. An idea is closed when it is done, duplicated or no longer wanted.
- This replaces the rule of ADR 0003 that ideas are one line each in the roadmap issue and become issues only when they are about to be worked on. The other rules of ADR 0003 stay in force.

## Consequences

- The issue list grows, and searching it for planned work means filtering by the label `roadmap`; the roadmap issue is unaffected.
- An idea can be linked from a session, a pull request or another issue, and gathers its discussion in one place.
- The ideas listed in the roadmap issue move into issues; the closed issues they came from can be reopened instead of duplicated.
- Agents may write ideas as issues without asking, as they may create issues today.
- Where a PiChamber idea list (#74) keeps local ideas in a repository whose tracker is GitHub or GitLab is not decided; it needs a decision when that list is built.

## Revisit when

Ideas drown out roadmap items or bugs in daily use, ideas are regularly kept somewhere other than the tracker, or the tracker of `workflow.json` changes.
