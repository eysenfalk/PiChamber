# Proof recording and publishing

## Ownership

This module owns scripted browser tours, visible evidence checks, artifact planning and attaching proof to a pull request. It reuses `scripts/perf/cdp.mjs` unchanged. No npm dependency is needed. Recording needs Node with WebSocket support (22.19 or newer), Chromium, ffmpeg with libx264 and drawtext, and a sans serif font (DejaVu Sans is requested through fontconfig). Publishing needs a gh release whose `gh pr edit` has `--attach` (2.102.0 has it) and write authority on the pull request.

The lab owns isolation, the image, network, prepared data and resource limits. Narrow Chromium emulation covers hosted mobile, not Capacitor or Electron. Never record real projects or credentials. Use the isolated lab; the only intended host recording target is the static fixture served by the recorder itself.

| File | Responsibility |
|---|---|
| `tours.mjs` | Tour data, schema validation, viewport presets, lab manifest consumer. |
| `visibility.mjs` | Pure geometry and serialized page evidence check. |
| `media.mjs` | Pure file planning, captions, ffmpeg arguments, screencast timing, index. |
| `record.mjs` | Chromium lifecycle, CDP actions, idle/evidence gates, ffmpeg execution. |
| `diagnostics.mjs` | Bounded, redacted page errors and failure report sidecars. |
| `checkout.mjs` | Commit/dirty metadata from host git or the lab controller. |
| `publish.mjs` | Artifact validation, Verification block in the description, `gh pr edit --attach`. |
| `fixtures/index.html` | Static synthetic data, including deliberately clipped evidence. |

## Tour format

A tour is `{ name, steps }`. Names contain lowercase letters, digits and hyphens, starting with a letter or digit. Each step has `caption` (up to 500 characters), `actions`, a nonempty `evidence` list, `viewport` and `theme`:

```js
{
  caption: 'The prepared session has a tool result.',
  viewport: 'desktop', // 1440x900; mobile = 390x844 with touch emulation
  theme: 'light',      // light or dark
  actions: [
    { type: 'click', text: 'Prepared session' },
    { type: 'wait', selector: '#tool-result' },
    { type: 'scroll', selector: '#tool-result' },
  ],
  evidence: [{ selector: '#tool-result' }, { text: 'Tool completed' }],
}
```

Actions execute in order:

- `navigate`: relative `path` on the target origin.
- `click`: exactly one `selector` or literal `text`; optional `button: 'right'` opens context menus.
- `hover`: exactly one `selector` or `text`; moves the pointer onto it without pressing, for controls that appear on hover.
- `long-press`: exactly one `selector` or `text`, only in a mobile step; holds a touch for 700 ms, past the 500 ms long press menus wait for.
- `press`: one `key` from `KEYS` in `tours.mjs` (arrows, Home, End, Enter, Escape), sent to the focused element.
- `drag`: `from` and `to`, each exactly one `selector` or `text`; holds the left button and moves in small steps so drag libraries activate.
- `type`: `selector` and `value`, selects existing input and inserts the value.
- `scroll`: `selector`, optional CSS pixel `x`/`y`. Without offsets, centers the first matching element.
- `wait`: either `ms` (0..30000), a selector that must be attached, or visible text. Target waits expire after 15s.
- `set-theme`: `theme` (light/dark).
- `set-viewport`: `viewport` (desktop/mobile).

Each step resets to its declared viewport/theme before actions. The final viewport action controls screenshot dimensions and caption planning. Unknown keys fail validation. Clicks require a visible, uncovered target; CDP delivers input rather than invoking React handlers. Mobile enables touch capability, which also gives `pointer: coarse` and `hover: none`. Chromium starts with a fine, hovering pointer (`--blink-settings`), because headless Chromium otherwise reports no hover and desktop steps would render touch affordances. Turning touch emulation off again restores headless's `hover: none`, so put desktop steps that depend on hover before mobile steps. Theme emulates the media query and sets the app's `themeMode` storage preference, dispatching the storage event consumed by ThemeSystemContext. Only the app's theme listener applies its classes; the recorder never toggles `html.dark`. The fixture has its own equivalent storage/media-query listener.

The `lab` tour reads `lab/seed-manifest.json` by default. The lab owns project names/paths and sessions with `project`, `title` and `role` (long/short). Project names and the long title are visible text targets, never a session row index. Project display labels deterministically replace hyphens/underscores with spaces and capitalize word initials, matching the sidebar formatter, so `lab-alpha` becomes `Lab Alpha`. The tour opens the exact long session title and expands its visible `Expand activity` control before checking visible `Edit File` text within the first `[data-chat-activity-row]`, so a reasoning row cannot pass as that tool call; dark evidence also requires app-applied `html.dark`. The hosted mobile step opens `mobile.html` and its sessions drawer through the header button. Evidence scopes the selected drawer button and checks the readable short session title from the manifest; the long title is intentionally ellipsized in the narrow drawer, so it is proven in the desktop header instead. Checking the entire drawer would incorrectly claim all its overflowed content is visible. The integration recording checks these targets in the real seeded app, not just source code.

The `fork-rename` tour also reads the manifest. It checks that a freshly started lab daemon lists the session with role `fork` under its manifest title in the desktop sidebar, keeps it when the session is opened, and shows it in the hosted mobile drawer. The seeded fork's head carries the parent title and its rename lies 600 KiB before the end of the file, so a reader that searches only a fixed tail window lists the parent title instead.

The `sidebar-tree` tour reads the manifest's `worktrees` and the session roles `long`, `fork`, `fork-child`, `worktree` and `chat`. It proves the workspace tree (issue #95) in the seeded app: Chats as the top-level node, a project that expands into its main checkout and linked worktrees, main's sessions, the fork chain behind the **Expand forks** toggles with its fork count, and the same tree in dark theme and in the hosted mobile drawer. Worktree rows are addressed by their `data-tree-node` key `w:<path>` from the manifest path, never by row index. Each manifest worktree carries a `git` state (`dirty`, `ahead-behind`, `rebase`) that the seed creates against the local `main` as upstream; the tour proves the git pills of each state and the collapsed project's `2 dirty` rollup. Merged pull requests need GitHub and are covered by unit tests only.

The `orchestration` tour reads the session role `orchestrator` (issue #107). The seeded orchestrator runs on the faux model of `scripts/lab/faux-orchestration.mjs`, whose script reacts to the words the tour types: `ORCHESTRATE` spawns the worker through `mcp__pichamber__session_spawn`, `STATUS?` gets an instant answer while the worker still thinks for ten seconds, and `GO` in the worker makes it report `done` through `mcp__pichamber__worker_report`. A run the owner starts sends no wake, the done report does. The orchestrator answers a wake only when its text starts like the daemon's (`A worker event:` or `N worker events:`); `scripts/lab/faux-orchestration.test.mjs` builds that text with the real `wakes.js`, so the two cannot drift. The tour proves the orchestration settings, the worker nested under its orchestrator, a responsive orchestrator, both wake rows (`pichamber.orchestration.events`) and the same in dark theme and the hosted mobile drawer. The worker title comes from that script.

The `worktree-worker` tour reads the same orchestrator (issue #179). `ORCHESTRATE WORKTREE` makes the faux model spawn `Lab: wt worker` in the linked worktree `fetch-me` of the orchestrator's project. The tour proves that the worker is a top-level session of that worktree (tree level 3) on desktop in both themes and in the hosted mobile drawer, instead of nested under its orchestrator in `main`.

The `extension-messages` tour reads the session role `extensions` (issue #147). The seed appends nine `intercom_message`, three `subagent-notify` and one `lab-context-note` custom message, as Pi extensions append them, between two turns. The first two steps prove only the seeded turns, on desktop and in the hosted mobile layout, so a build from before the change records the same view and fails at step 3; that is the before picture. The later steps prove one compact row per kind inside `.chat-message-column`, the expanded intercom run and one message rendered as Markdown, in dark theme and on mobile.

The `html-render` tour reads the session role `html-render` (issue #155). That session runs on the faux model, whose script answers `RENDER` with a real `html_render` call carrying a small self-contained build report page; the daemon stores and serves it like any agent's page. The tour proves the sandboxed inline frame (`sandbox="allow-scripts allow-forms"`, never `allow-same-origin`) in light and dark theme, the full screen dialog at 125 % zoom, the page after a reload and in the hosted mobile layout. The page itself is cross-origin to the app, so its content (the theme colors and the probe line saying the script ran and the parent document is blocked) is proven by inspecting the screenshots, not by evidence selectors.

The `tool-profiles` tour reuses the orchestrator session (issue #151). On `REVIEW` the faux model calls `session_spawn` with role `review`, so the worker gets the `read-only` tool profile; the worker's script calls `edit`, `write` and then `bash` to check with git that README.md is unchanged. Both the orchestrator's and the worker's answers list the tools the daemon sent to the model, read from the request itself, so the tour shows the full and the read-only tool set side by side.

The `recreated-worktree` tour reads the worktree with git state `ahead-behind` and its session of role `worktree` (issue #160). It closes that worktree through the tree's context menu, so its directory is removed and its session leaves the tree with it. It then recreates the worktree at the same path with `git worktree add` in the built-in terminal and waits, without a reload, until background worktree discovery (every 60 s, results fresh for 30 s) lists the worktree again and the tree shows the session under it. The failure before the fix (the closed worktree's session committed as deleted, hidden until a reload) is pinned by `useSidebarSessions.test.tsx`, not by this tour.

The `control-center` tour reuses the orchestrator session (issues #20, #87). On `ASK` the faux model spawns `Lab: asker`, whose task makes it call `worker_report` with a `question` for the owner and a brief; the orchestrator's script leaves that question to the owner, as its instructions say. On `CHOOSE` it spawns `Lab: chooser` in the project's worktree (one worker per directory), whose `lab_choose` tool opens two `select` dialogs one after the other; the second waits 3 s, so the owner answers the first in the chooser's chat (a dialog shows only in its own session's chat, #215) and reaches the control center before the second opens. The tour proves the header count of waiting decisions, the chat dialog after the `ExtensionDialogBody` extraction, the question with its brief and the second dialog in the decision inbox, both worker rows under their orchestrator with slots and host load, a dialog answered from the inbox (the chooser's transcript names both answers), an answer sent from the inbox (the worker receives it as the owner's prompt and asks a follow-up), the answer in the worker's transcript, the session list filter **Only workers**, the open follow-up in dark theme and in the full screen view of the hosted mobile layout, and **Mark answered** closing it there without a prompt. Answers are read with the 5 s overview poll, so the waits allow for it.

The `start-last-session` tour reads the first project, where the lab server starts and so where the daemon's default runtime lives, its `long` session, and the first `short` session of another project (issues #104, #89, #16). It loads the app twice without input on the recorder's fresh browser profile: the first load expands the first project's main checkout, whose rows must hold no "Awaiting first prompt" session (checked by inspection, evidence cannot prove an absence); then it opens the other project's session and reloads, and the header must show that session again, not the newest one of the first project. In the built-in terminal it counts the JSONL files under the lab's Pi session directory that the seed manifest `/lab/seed.json` does not list, which must be 0. Opening a session appends to its file, so modification times cannot show a new session. Hosted mobile must open on the same session. A truly empty server profile needs no lab seed and is covered by the daemon and store tests instead.

The `add-device` tour needs no manifest. It opens the **Add a device** dialog in desktop and mobile, light and dark: desktop through `?settings=remote-instances`, hosted mobile (which ignores that parameter) through the sessions drawer, Settings and **Manage instances & pair devices**. The lab pod has no Tailscale interface, so each step requires **Home network only** to be the selected radio and **Tailscale (recommended)** to be disabled with its not-available hint. The Tailscale state itself cannot be recorded in the lab.

## Evidence rule

Every evidence item must pass at the same time. A selector checks all matches, or one explicit zero based `index`. Missing matches fail. A selector plus `text` requires that visible literal within each selected element, not elsewhere on the page. Text searches rendered text nodes for a whitespace-normalized literal, requiring at least one fully visible occurrence, not hidden textContent or script contents. Text spanning multiple DOM text nodes is intentionally not matched: use a selector instead.

All positive rectangles must fit fully within the CSS viewport. Every ancestor with non-visible overflow clips on its corresponding axis, using the inner border and client size. Hidden, transparent or inert evidence fails. Overflowing content within the evidence (and its descendants) also fails; text cannot be silently truncated. These rules port jira-connector's check, without its four pixel clipping slack and with axis-specific clips. Arbitrary overlay occlusion is not an evidence geometry guarantee; inspect every image and the contact sheet.

`evidenceExpression` serializes `checkEvidence` and the pure `visibilityReason` into one Runtime.evaluate expression. Browser globals are used only in the page, never at import. DOM fixture tests need no Chromium.

Before a screenshot the page must be complete, fonts ready, with 500ms of DOM mutation and finite network quiet. SSE/WebSockets do not hold this gate open, including fetch-backed SSE responses identified by their `text/event-stream` MIME type. CDP requests with an empty loaderId are worker-owned: their finish events belong to another target and are excluded from the page network gate. A committed top-level frame also drops requests from the replaced document, retaining requests owned by the new loader; canceled old fetches need not emit finish events to this target. The DOM and evidence gates still check visible effects. This is page idle, not a claim that worker computation has stopped. Idle expires after 15s instead of assuming success. Evidence is checked after idle and again after a static hold, immediately before the screenshot.

## Host fixture reproduction

```sh
bun test scripts/proof
node scripts/proof/record.mjs fixture --chrome /usr/bin/google-chrome --ffmpeg /usr/bin/ffmpeg
ffprobe -v error -show_entries stream=codec_name,pix_fmt:format=duration -of json .proof/fixture/video.mp4
node scripts/proof/record.mjs fixture-broken --chrome /usr/bin/google-chrome --ffmpeg /usr/bin/ffmpeg
# Last command must exit 1, reporting clipped by div and writing 01-not-proven.png.
```

Before opening a browser, the recorder accepts only HTTP(S) URLs without credentials on `127.0.0.1`, `::1`, `localhost` or the lab pod host `pichamber-lab`. This gate also applies to fixtures and rejects external/LAN targets.

For the lab provide `--url` or `PROOF_URL`, `--chrome` or `PROOF_CHROME`, and `--ffmpeg` or `PROOF_FFMPEG`. `--manifest` overrides the manifest path. `lab/run record <tour>` owns the lab-only URL, read-only source and writable `.proof/` mount, fixed aggregate budget, and container-only Chrome sandbox launcher. Each recording creates and cleans up its own temporary Chromium profile. SIGINT/SIGTERM request cancellation; protocol calls and subprocesses have deadlines.

## Output and failures

Each run replaces only `.proof/<tour>/`, removing stale success markers:

- `01.png`, `02.png`, ...: app viewport followed by a caption band below it. ffmpeg pads the image and renders one textfile per wrapped line with expansion disabled. Captions never cover the app, including on mobile.
- `video.mp4`: actual CDP screencast JPEG frames and epoch timestamps, with static intervals preserved. Frames arriving behind the last retained timestamp are dropped, never sorted into earlier actions; malformed frames and invalid end times still fail. H.264, yuv420p limited range, faststart, 1440x900 at 30 fps. Mobile fits centered in this even canvas. Video shows actions, without captions.
- `contact-sheet.png`: all captioned images fitted into a two column grid.
- `index.md`: captions, PNGs, contact sheet and video links.
- `report.json`: proven/not-proven status, declared evidence, selector verification metadata, `checkout: { commit, dirty }` captured from the source checkout, and `droppedScreencastFrames` (late frames discarded during video planning). The lab passes `PROOF_COMMIT` and `PROOF_DIRTY` from host git; host fixtures read git directly.

On failure the command exits nonzero and writes a not-proven report. A step failure with an available page writes `NN-not-proven.png` with a NOT PROVEN band. If ffmpeg fails, the raw screenshot is retained under that name. Temporary `raw/` files are removed only on success and cannot be published. The report records its failure phase; startup, screencast, video and contact-sheet failures have phase-named JSON sidecars rather than being attributed to the last step or taking a misleading step screenshot. Browser startup failure may have no screenshot. Completed steps do not make an incomplete tour proven. Every failure includes diagnostics in `report.json` and adjacent `NN-not-proven.json` (or `<phase>-not-proven.json`): current URL (up to 2048 characters, without credentials/query/fragment), error boundary details text (including closed details), and the most recent 50 Runtime exceptions, Log errors and console.error events (4096 characters each; boundary text 8192). Objects are not expanded; credential fields, Basic/Bearer values, whole cookie/authorization headers and opaque token strings are redacted before persistence. If page evaluation fails, the fallback target URL and capture error are explicit. Diagnostics never replace or relax evidence checks; only synthetic lab/fixture pages are allowed.

## Publishing

```sh
bun run proof:publish -- 27 lab --dry-run
bun run proof:publish -- 27 lab
```

Default repository: `workflow.json`'s `tracker.repo`; `--repo` or `PROOF_REPO` overrides it. Publishing attaches proof to the pull request description; nothing is committed or pushed ([ADR 0005](../../docs/adr/0005-proof-attached-to-pull-requests.md)).

Publishing rejects incomplete reports, unexpected files, symlinks, empty artifacts and source commit metadata differing from HEAD, before calling gh. Record again after committing source changes. The dirty flag is retained, not treated as proof of a clean source tree. A gh without `gh pr edit --attach` fails with an explicit message.

It reads the current description and writes one block per tour between `<!-- proof:<tour> -->` and `<!-- /proof:<tour> -->`: the tour name and recorded commit, the video alone in its paragraph so GitHub renders a player, the contact sheet, then every screenshot with its caption as alt text. A new block goes to the end of the `## Verification` section; an existing block for the same tour is replaced and everything else in the description stays byte for byte. A description without that section fails. The block references `./video.mp4`, `./contact-sheet.png` and `./NN.png`; `gh pr edit --body-file ... --attach ./<file>` runs inside `.proof/<tour>/`, uploads each file and rewrites those references to the hosted assets. `report.json` and `index.md` stay local.

After the edit the description is read again. Success prints the hosted block on stdout. If any reference is still local, the command fails rather than claiming publication. If some uploads fail, gh keeps the successful ones in the description and exits nonzero, and so does this command; rerunning replaces the whole block. Replaced uploads stay in GitHub's attachment storage. `--dry-run` reads the description and prints the block with local references, labeled unpublished, without editing.

The commands are non-interactive and behave identically in TTYs and pipes. Unsupported flags fail with one usage line on stderr; the block goes only to stdout. Product CLI quiet/JSON modes do not apply to these repository automation scripts. gh subprocess output is captured; surfaced errors are bounded and credential-redacted, and raw subprocess error messages (which repeat command arguments) are never printed. Tests use a fake gh, never GitHub; actual upload, rendering and playback remain an integration check. Review every artifact before publishing. Publication does not prove lab isolation or resource budgets.
