# 0006. Intent as the primitive: work organized by accepted intents, not by sessions

- Status: Proposed
- Date: 2026-10-05
- Waits for: the prototype in #70 showing that a blocking question after a turn stops a session cleanly and that a fork keeps the plugin entries up to its fork point, then the owner confirming the model

## Context

PiChamber lists sessions grouped by project. The owner runs many sessions in parallel, often around twenty and up to a hundred over time, and loses the thread. #20 states the cause (2026-10-03): "Intent and session are the same thing today: a session takes its title from the first prompt, often drifts across several topics, and forks keep the same name." A typical session carries several intents in sequence, for example three pull requests merged and a fourth in progress. Forks split a session into parallel lines of thought with a shared source, recursively. None of this is visible.

In a brainstorm on 2026-10-04 the owner decided:

- The primitive is the intent, the reason work is done, not the session.
- An idea is not an intent. An intent is the will to carry something out; a pull request is an intent, but research, questions and work on `main` are intents too.
- Intents are checkpoints set by a PiChamber Pi plugin. The small model proposes them; the user accepts, rewords or rejects. The point is that user and AI agree on the goal.
- Intents can be switched on or off per session; a cheap judgment model such as Jev may decide whether the check runs.
- Facts are indexed automatically; model interpretations (summaries, next goal, suggested relations) are refreshed by a button, and their freshness is visible per session.
- Layout: left an intent tree with a flat legacy list as in OpenChamber, in the middle a project map on a time axis, right a menu named Flow with a local graph and details. Forking from an earlier intent works from the map without opening the session.

A review of the first draft on this pull request (2026-10-04) found that stopping the session at every intent change adds the friction the model is meant to remove, that an intent continuing in another session or fork would become two unrelated checkpoints, that intents have no end, that the audit attribution is only implied, and that a small model call after every turn is more than needed. On 2026-10-05 the owner adopted those points and decided how rejections, relations, ideas and the inbox are kept; the rules below include them.

What Pi and PiChamber provide, checked on 2026-10-05 against Pi 1.0.2 and this repository:

- `pi.appendEntry()` persists session data excluded from model context; `turn_end` is a boundary where an extension can act (Pi `docs/extensions.md`).
- A forked session records its parent session (Pi `docs/session-format.md`); whether custom entries on the path are copied is not documented.
- The daemon forks at an entry: `POST /api/pi/sessions/:id/fork` calls `runtime.fork(entryId, { position: 'at' })` (`packages/web/server/lib/pi/routes.js`, `session-daemon/session-daemon.js`).
- Blocking extension dialogs (`ctx.ui.select/confirm/input/editor/form`) reach every connected client and stay pending until answered (`session-daemon/DOCUMENTATION.md`).
- `/api/pi/small-model/generate` runs the configured small model, falling back to the default model, statelessly without tools (`packages/ui/src/lib/pi/DOCUMENTATION.md`), so the caller must pass the turn content.

Alternatives considered:

- **Session as primitive with better names** (#4): one name cannot describe a session that served four intents.
- **Issue as intent**: many issues are never worked on, and a lot of work happens without an issue.
- **A graph everywhere, also in the left sidebar**: a free graph becomes unreadable beyond roughly fifty nodes and does not fit a narrow sidebar; a tree finds and switches faster there.
- **Stop the session at every intent change** (first draft): user and agent agree at once, but every change costs a halt, which with twenty parallel sessions is constant interruption.

## Decision

- **Terms.** Idea: something that could be done; its record and sources are defined in ADR 0007. Intent: the will to carry something out, with or without a pull request, with an id that stays the same across sessions. Checkpoint: an accepted intent stored in a session. Session: a time track carrying intents in sequence. Fork: a split of a time track at an entry, recursively.
- **Storage.** Checkpoints, rejected proposals, the per-session switch and relations the user confirmed are entries in the Pi session file, written by the intent plugin. The session files are the authoritative record of them. Model interpretations and facts read from GitHub are kept in a PiChamber cache that can be rebuilt and never competes with the session files.
- **Identity.** An intent has a stable id. A fork inherits the active intent and its id. When a session continues an intent from another session, the plugin proposes the existing id and the user confirms it; a checkpoint never joins an intent without that confirmation.
- **When to check.** The plugin checks for an intent change only on a signal: a new user message, a branch switch, a pull request created or merged. Deterministic checks run first; the small model runs only when they cannot decide.
- **Provisional intents.** A proposed intent is provisional and appears as a card in the session; the session keeps running. The user accepts, rewords or rejects it there. Accepting or rewording makes it a checkpoint. Rejecting records the rejection and the session continues with the intent it had. A session without an answer keeps its previous intent.
- **Hard changes block.** A branch switch, a new pull request, or a rule that requires it stops the session with a blocking question until the user decides.
- **Workers.** For a managed worker (#20), a proposed intent change is drift: it is reported, not adopted.
- **End states.** An intent ends as done, abandoned or superseded by another intent. Tied to a merge or a closed issue the end state is a fact; otherwise it is an interpretation until the user confirms it.
- **Pull requests and issues.** The plugin suggests links between an intent and a pull request or issue; the user confirms them. A pull request may carry several intents, and an issue may lead to several pull requests. Merging a pull request ends its intents as done, except those already abandoned.
- **Audit.** Everything between two checkpoints of a session, tool calls, commands and file changes, belongs to the intent that was active.
- **Per session.** Intents are on by default and can be switched off per session; the switch is a plugin entry.
- **Facts and interpretation.** Fork links, fork points, timestamps, branches, pull requests and merges are facts, indexed automatically. Summaries, next goals and relations such as superseded or duplicate are interpretations, refreshed on demand and shown as suggestions until the user confirms them. Every view shows how current both are.
- **Layout.** Left: intent tree, with a flat legacy session list as the alternative. Middle: project map with sessions as lanes on a time axis and intents as segments. Right: the Flow menu with the local graph, details and freshness. Forking at an earlier checkpoint opens a session in which that intent is active again.
- **Runtimes.** The intent card, the blocking question and the tree work on desktop, web, hosted mobile and the Capacitor app. On mobile, Flow opens as a sheet and the map is navigated by pan and zoom.

## Consequences

- Signal-based checks with deterministic pre-checks keep model calls rare; a session pays latency only when a signal fires and the pre-checks cannot decide.
- Agreement on a provisional intent can come late, because the session does not wait for it. Until the cross-session decision inbox exists, provisional intents are visible only inside their session.
- A blocking question needs someone to answer. For managed workers the chief of staff or the decision inbox must be able to take it.
- Session files gain plugin entries. They stay out of model context, and Pi clients without the plugin ignore them. If a fork does not copy them, storage needs a new record before #70 continues.
- The left sidebar changes shape; pins and "working on" (#2) must keep working in both views.
- #1, #13 and #15 become parts of this work (#74); #3 and #4 may build on intents.

## Revisit when

The user rejects proposals or switches intents off in most sessions, provisional intents pile up unanswered, the check cost or latency becomes noticeable in daily use, or Pi changes how session entries or forks work, for example through the planned hard fork.
