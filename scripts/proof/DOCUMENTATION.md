# Proof recording and publishing

## Ownership

This module owns scripted browser tours, visible evidence checks, artifact planning and host publishing. It reuses `scripts/perf/cdp.mjs` unchanged. No npm dependency is needed. Recording needs Node with WebSocket support (22.19 or newer), Chromium, ffmpeg with libx264 and drawtext, and a sans serif font (DejaVu Sans is requested through fontconfig). Publishing needs git and the host's git identity.

The lab owns isolation, the image, network, prepared data and resource limits. Narrow Chromium emulation covers hosted mobile, not Capacitor or Electron. Never record real projects or credentials. Use the isolated lab; the only intended host recording target is the static fixture served by the recorder itself.

| File | Responsibility |
|---|---|
| `tours.mjs` | Tour data, schema validation, viewport presets, lab manifest consumer. |
| `visibility.mjs` | Pure geometry and serialized page evidence check. |
| `media.mjs` | Pure file planning, captions, ffmpeg arguments, screencast timing, index. |
| `record.mjs` | Chromium lifecycle, CDP actions, idle/evidence gates, ffmpeg execution. |
| `publish.mjs` | Artifact validation, temporary staging repository/worktree, commit/push, Markdown. |
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
- `click`: exactly one `selector` or literal `text`.
- `type`: `selector` and `value`, selects existing input and inserts the value.
- `scroll`: `selector`, optional CSS pixel `x`/`y`. Without offsets, centers the first matching element.
- `wait`: either `ms` (0..30000), a selector that must be attached, or visible text. Target waits expire after 15s.
- `set-theme`: `theme` (light/dark).
- `set-viewport`: `viewport` (desktop/mobile).

Each step resets to its declared viewport/theme before actions. The final viewport action controls screenshot dimensions and caption planning. Unknown keys fail validation. Clicks require a visible, uncovered target; CDP delivers input rather than invoking React handlers. Mobile enables touch capability. Theme emulates the media query and sets the app's `themeMode` storage preference, dispatching the storage event consumed by ThemeSystemContext. The fixture also uses `html.dark`.

The `lab` tour reads `lab/seed-manifest.json` by default. The lab owns project names/paths and sessions with `project`, `title` and `role` (long/short). Project names and the long title are visible text targets, never a session row index. Project display labels deterministically replace hyphens/underscores with spaces and capitalize word initials, matching the sidebar formatter, so `lab-alpha` becomes `Lab Alpha`. The tour opens the exact long session title and expands its visible `Expand activity` control before checking `[data-chat-activity-row]`; dark evidence also requires `html.dark`. The hosted mobile step opens `mobile.html` and its sessions drawer through the header button. Evidence scopes the selected drawer button and checks the readable short session title from the manifest; the long title is intentionally ellipsized in the narrow drawer, so it is proven in the desktop header instead. Checking the entire drawer would incorrectly claim all its overflowed content is visible. The integration recording checks these targets in the real seeded app, not just source code.

## Evidence rule

Every evidence item must pass at the same time. A selector checks all matches, or one explicit zero based `index`. Missing matches fail. Text searches rendered text nodes for a whitespace-normalized literal, requiring at least one fully visible occurrence, not hidden textContent or script contents. Text spanning multiple DOM text nodes is intentionally not matched: use a selector instead.

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

For the lab provide `--url` or `PROOF_URL`, `--chrome` or `PROOF_CHROME`, and `--ffmpeg` or `PROOF_FFMPEG`. `--manifest` overrides the manifest path. `lab/run record <tour>` owns the lab-only URL, read-only source and writable `.proof/` mount, fixed aggregate budget, and container-only Chrome sandbox launcher. Each recording creates and cleans up its own temporary Chromium profile. SIGINT/SIGTERM request cancellation; protocol calls and subprocesses have deadlines.

## Output and failures

Each run replaces only `.proof/<tour>/`, removing stale success markers:

- `01.png`, `02.png`, ...: app viewport followed by a caption band below it. ffmpeg pads the image and renders one textfile per wrapped line with expansion disabled. Captions never cover the app, including on mobile.
- `video.mp4`: actual CDP screencast JPEG frames and epoch timestamps, with static intervals preserved. Frames arriving behind the last retained timestamp are dropped, never sorted into earlier actions; malformed frames and invalid end times still fail. H.264, yuv420p limited range, faststart, 1440x900 at 30 fps. Mobile fits centered in this even canvas. Video shows actions, without captions.
- `contact-sheet.png`: all captioned images fitted into a two column grid.
- `index.md`: captions, PNGs, contact sheet and video links.
- `report.json`: proven/not-proven status, declared evidence, selector verification metadata, and `droppedScreencastFrames` (late frames discarded during video planning).

On failure the command exits nonzero and writes a not-proven report. If a page is available it writes `NN-not-proven.png` with a NOT PROVEN band. If ffmpeg fails, the raw screenshot is retained under that name. Temporary `raw/` files are removed only on success and cannot be published. Browser startup failure may have no screenshot. Completed steps do not make an incomplete tour proven.

## Publishing

```sh
bun run proof:publish -- 27 lab
bun run proof:publish -- 27 fixture --remote /absolute/path/to/local-bare.git --dry-run
```

Default repository: `workflow.json`'s `tracker.repo`; `--repo` or `PROOF_REPO` overrides it for URLs. `--remote` or `PROOF_REMOTE` overrides `origin`, accepting a configured name, URL or local repository path. Tests use temporary local bare repositories only, never GitHub.

Publishing rejects incomplete reports, unexpected files, symlinks and empty artifacts. It creates an isolated temporary git repository and linked worktree, fetches `proofs` if present, or creates it as an orphan branch. It replaces only `pr-<n>/<tour>/`, commits changes and pushes without force. An identical retry adds no commit. A concurrent remote change rejects the push; rerun to fetch and append safely. The host's checkout, index, refs and worktree registry remain untouched, even with unrelated edits. Temporary worktrees are removed in finally. Errors never print publication success.

`--dry-run` validates, fetches and prepares a temporary commit, but never pushes and labels Markdown as unpublished. Successful stdout is Markdown with `raw.githubusercontent.com/<repo>/proofs/pr-<n>/<tour>/...` images and a video link. The commands are non-interactive and behave identically in TTYs and pipes. Unsupported flags fail with one usage line on stderr; publish Markdown goes only to stdout. Product CLI quiet/JSON modes do not apply to these repository automation scripts. Raw URLs require a public repository; actual GitHub rendering/playback remains an integration check. Review every artifact before publishing. Publication does not prove lab isolation or resource budgets.
