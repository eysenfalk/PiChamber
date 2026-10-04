# 0006. Intent as the primitive: work organized by accepted intents, not by sessions

- Status: Proposed
- Date: 2026-10-04
- Waits for: the owner confirming the model once the prototype in #70 shows that a blocking question after a turn stops a session cleanly

## Context

PiChamber lists sessions grouped by project. The owner runs many sessions in parallel, often around twenty and up to a hundred over time, and loses the thread. #20 states the cause (2026-10-03): "Intent and session are the same thing today: a session takes its title from the first prompt, often drifts across several topics, and forks keep the same name." A typical session carries several intents in sequence, for example three pull requests merged and a fourth in progress. Forks split a session into parallel lines of thought with a shared source, recursively. None of this is visible.

In a brainstorm on 2026-10-04 the owner decided:

- The primitive is the intent, the reason work is done, not the session.
- An issue is an idea, not an intent. An intent is the will to carry something out; a pull request is an intent, but research, questions and work on `main` are intents too.
- Intents are checkpoints set by a PiChamber Pi plugin. The small model proposes them automatically after turns; on a change the session stops and the user accepts, rewords or rejects. Reject stops the session or asks again. The point is that user and AI agree on the goal.
- Intents can be switched on or off per session; a cheap judgment model such as Jev may decide whether the check runs.
- Facts are indexed automatically; model interpretations (summaries, next goal, suggested relations) are refreshed by a button, and their freshness is visible per session.
- Layout: left an intent tree with a flat legacy list as in OpenChamber, in the middle a project map on a time axis, right a menu named Flow with a local graph and details. Forking from an earlier intent works from the map without opening the session.

What Pi and PiChamber already provide, checked on 2026-10-04 against Pi 0.99.2 and this repository:

- `pi.appendEntry()` persists session data excluded from model context; `turn_end` is a boundary where an extension can act (Pi `docs/extensions.md`).
- The daemon forks at an entry: `POST /api/pi/sessions/:id/fork` calls `runtime.fork(entryId, { position: 'at' })` (`packages/web/server/lib/pi/routes.js`, `session-daemon/session-daemon.js`).
- Blocking extension dialogs (`ctx.ui.select/confirm/input/editor/form`) reach every connected client and stay pending until answered (`session-daemon/DOCUMENTATION.md`).
- `/api/pi/small-model/generate` runs the configured small model, falling back to the default model, statelessly without tools (`packages/ui/src/lib/pi/DOCUMENTATION.md`), so the caller must pass the turn content.

Alternatives considered:

- **Session as primitive with better names** (#4): one name cannot describe a session that served four intents.
- **Issue as intent**: many issues are never worked on, and a lot of work happens without an issue.
- **A graph everywhere, also in the left sidebar**: a free graph becomes unreadable beyond roughly fifty nodes and does not fit a narrow sidebar; a tree finds and switches faster there.

## Decision

- **Terms.** Idea: something that could be done; a GitHub issue is an idea. Intent: the will to carry something out, with or without a pull request. Checkpoint: an accepted intent stored in a session. Session: a time track carrying intents in sequence. Fork: a split of a time track at an entry, recursively.
- **Storage.** A checkpoint is an entry in the Pi session file, written by the intent plugin. The session file is the authoritative record of accepted intents; PiChamber may keep derived indexes and caches, but they can be rebuilt from the session files and never compete with them.
- **Creation.** The small model proposes an intent after a turn. Only an intent the user accepts, or rewords and accepts, becomes a checkpoint. A rejected proposal never becomes one.
- **Per session.** Intents can be switched on or off per session, with a default.
- **Facts and interpretation.** Fork links, fork points, timestamps, branches, pull requests and merges are facts, indexed automatically. Summaries, next goals and relations such as superseded or duplicate are interpretations, refreshed on demand and shown as suggestions until the user confirms them. Every view shows how current both are.
- **Layout.** Left: intent tree, with a flat legacy session list as the alternative. Middle: project map with sessions as lanes on a time axis and intents as segments. Right: the Flow menu with the local graph, details and freshness. Forking at an earlier checkpoint opens a session in which that intent is active again.

## Consequences

- With intents on, every turn costs a small model call and some latency before the session can continue. A cheap gate or deterministic pre-checks (branch switch, pull request created, merge) may be needed.
- A session that stops at an intent change needs someone to answer. For managed workers (#20) the chief of staff or the decision inbox must be able to take the question.
- Session files gain plugin entries. They stay out of model context, and Pi clients without the plugin ignore them.
- The left sidebar changes shape; pins and "working on" (#2) must keep working in both views.
- #1, #13 and #15 become parts of this work (#74); #3 and #4 may build on intents.

## Revisit when

The user rejects proposals or switches intents off in most sessions, the per-turn cost or latency becomes noticeable in daily use, or Pi changes how session entries or forks work, for example through the planned hard fork.
