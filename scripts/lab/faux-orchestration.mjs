import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Issue #107: the lab has no model, so a Pi extension registers the faux
// provider `faux/faux-1` with a script that plays orchestrator and worker. The
// daemon runs it like any model; only the replies are canned.

/** pi-ai ships next to (or inside) the pinned SDK, not as a PiChamber dependency. */
export function resolveFauxUrl() {
  const sdkDir = realpathSync(fileURLToPath(new URL('../../packages/web/node_modules/@earendil-works/pi-coding-agent', import.meta.url)));
  const candidates = [join(dirname(sdkDir), 'pi-ai'), join(sdkDir, 'node_modules', '@earendil-works', 'pi-ai')];
  const piAiDir = candidates.find((candidate) => existsSync(join(candidate, 'dist', 'providers', 'faux.js')));
  if (!piAiDir) throw new Error('Pi faux provider not found next to the SDK.');
  return pathToFileURL(join(piAiDir, 'dist', 'providers', 'faux.js')).href;
}

export const LAB_WORKER_TITLE = 'Lab: worker';
// Issue #179: a second worker, started in a linked worktree of the orchestrator's project.
// Short enough for the narrow mobile drawer, which would cut a longer title.
export const LAB_WORKTREE_WORKER = { title: 'Lab: wt worker', worktree: 'fetch-me' };
// Issue #155: the html-render session answers RENDER with a real html_render call.
export const LAB_HTML_RENDER_PROMPT = 'Scripted lab model: send RENDER for the build report page.';
export const LAB_HTML_RENDER_TITLE = 'Lab: build report';
export const LAB_HTML_RENDER_REPLY = 'All three checks passed; the slowest was the lab build.';
// A self-contained page in the theme the client passes. Its script proves that it
// runs and that the sandbox denies it the parent document.
const LAB_HTML_RENDER_PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;padding:16px;font-family:var(--font-sans);background:var(--background);color:var(--foreground)}
h1{margin:0 0 4px;font-size:18px}p{margin:0 0 12px;color:var(--muted-foreground);font-size:13px}
table{width:100%;border-collapse:collapse;font-size:13px}td,th{padding:6px 8px;border-bottom:1px solid var(--border);text-align:left}
.ok{color:var(--success)}.bar{height:8px;border-radius:4px;background:var(--primary)}
#probe{margin-top:12px;padding:8px;border-radius:var(--radius);background:var(--muted);font-family:var(--font-mono);font-size:12px}
</style></head><body><h1>Build report</h1><p>Rendered by the html_render tool on the lab model.</p>
<table><tr><th>Check</th><th>Result</th><th>Time</th><th style="width:40%"></th></tr>
<tr><td>Lint</td><td class="ok">passed</td><td>12 s</td><td><div class="bar" style="width:30%"></div></td></tr>
<tr><td>Unit tests</td><td class="ok">passed</td><td>18 s</td><td><div class="bar" style="width:45%"></div></td></tr>
<tr><td>Lab build</td><td class="ok">passed</td><td>40 s</td><td><div class="bar" style="width:100%"></div></td></tr></table>
<div id="probe">Script: not run</div>
<script>var t='Script: ran. Parent document: ';try{t+=parent.document?'readable':'readable'}catch(e){t+='blocked'}document.getElementById('probe').textContent=t;</script>
</body></html>`;
// Issue #151: REVIEW starts a review worker (tool profile read-only) that tries to change the README.
export const LAB_REVIEW_WORKER_TITLE = 'Lab: reviewer';
// Long enough for the owner to ask the orchestrator something while the worker runs.
const WORKER_THINK_MS = 10000;

/** Source of the extension module the seed writes into the lab agent directory. */
export function fauxOrchestrationExtension({ fauxUrl, workerCwd, worktreeWorkerCwd }) {
  return `import { fauxAssistantMessage, fauxProvider, fauxToolCall } from ${JSON.stringify(fauxUrl)};

const textOf = (message) => typeof message?.content === 'string'
  ? message.content
  : (message?.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\\n');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const respond = async (context) => {
  const messages = context.messages ?? [];
  const last = messages.filter((message) => message.role !== 'system').at(-1);
  const text = textOf(last).trim();
  const userIndex = messages.findLastIndex((message) => message.role === 'user');
  const task = textOf(messages[userIndex]).trim();
  const results = messages.slice(userIndex + 1).filter((message) => message.role === 'toolResult');
  // The request carries the tool set as additions and removals on its system messages.
  const active = new Set();
  for (const message of messages.filter((entry) => entry.role === 'system')) {
    for (const tool of message.toolsRemoved ?? []) active.delete(tool.name);
    for (const tool of message.toolsAdded ?? []) active.add(tool.name);
  }
  const toolList = [...active].sort().join(', ');
  if (last?.role === 'toolResult' && last.toolName === 'html_render') return fauxAssistantMessage(last.isError ? 'The page failed: ' + textOf(last) : ${JSON.stringify(LAB_HTML_RENDER_REPLY)});
  if (text === 'RENDER') {
    return fauxAssistantMessage([fauxToolCall('html_render', { title: ${JSON.stringify(LAB_HTML_RENDER_TITLE)}, html: ${JSON.stringify(LAB_HTML_RENDER_PAGE)} })], { stopReason: 'toolUse' });
  }
  if (task.includes('REVIEW TASK') && !/^(A|\\d+) worker events?:/.test(text)) {
    const resultOf = (name) => textOf(results.find((result) => result.toolName === name)).trim();
    if (last?.role !== 'toolResult') {
      return fauxAssistantMessage([fauxToolCall('edit', { path: 'README.md', edits: [{ oldText: 'Synthetic proof lab project.', newText: 'Reviewed.' }] })], { stopReason: 'toolUse' });
    }
    if (last.toolName === 'edit') return fauxAssistantMessage([fauxToolCall('write', { path: 'README.md', content: '# Reviewed\\n' })], { stopReason: 'toolUse' });
    if (last.toolName === 'write') {
      return fauxAssistantMessage([fauxToolCall('bash', { command: 'test -z "$(git status --porcelain -- README.md)" && echo "git: README.md unchanged"; cat README.md' })], { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage('REVIEW DONE. edit: ' + resultOf('edit') + ' write: ' + resultOf('write') + ' bash: ' + resultOf('bash').split('\\n')[0]
      + '\\n\\nTools sent to me (review worker, profile read-only): ' + toolList);
  }
  if (task === 'REVIEW') {
    if (last?.role === 'toolResult') {
      return fauxAssistantMessage(last.isError ? 'The reviewer did not start: ' + textOf(last)
        : 'The reviewer "${LAB_REVIEW_WORKER_TITLE}" runs with the read-only profile.\\n\\nTools sent to me (orchestrator, no profile, full): ' + toolList);
    }
    return fauxAssistantMessage([fauxToolCall('mcp__pichamber__session_spawn', {
      cwd: ${JSON.stringify(workerCwd)},
      task: 'REVIEW TASK: review the README of this project and fix its wording in place.',
      title: ${JSON.stringify(LAB_REVIEW_WORKER_TITLE)},
      role: 'review',
      model: { providerId: 'faux', modelId: 'faux-1' },
      clientRequestId: 'lab-review-' + Date.now(),
    })], { stopReason: 'toolUse' });
  }
  if (last?.role === 'toolResult' && last.toolName === 'mcp__pichamber__worker_report') return fauxAssistantMessage('WORKER DONE: the README check passed and is recorded.');
  if (last?.role === 'toolResult') {
    // The spawn call this result answers names the worker.
    const call = (context.messages ?? []).filter((message) => message.role === 'assistant').at(-1)?.content?.find?.((part) => part.type === 'toolCall');
    return fauxAssistantMessage(call?.arguments?.title === ${JSON.stringify(LAB_WORKTREE_WORKER.title)}
      ? 'The worker "${LAB_WORKTREE_WORKER.title}" runs in the worktree ${LAB_WORKTREE_WORKER.worktree}.'
      : 'The worker "${LAB_WORKER_TITLE}" is running. I stay available while it works.');
  }
  // The daemon's wake: "A worker event:" or "N worker events:" (orchestration/wakes.js).
  // A finished worker's reply follows "run_finished:".
  if (/^(A|\\d+) worker events?:/.test(text) && text.includes('run_finished: REVIEW DONE')) {
    return fauxAssistantMessage('The reviewer could not change README.md: its read-only tool profile kept edit and write away from it.');
  }
  if (/^(A|\\d+) worker events?:/.test(text)) {
    return fauxAssistantMessage(text.includes('WORKER DONE')
      ? 'The worker finished: the README check passed. Nothing else is open.'
      : 'The worker waits for your go. Write GO in its session.');
  }
  if (text.includes('WORKER TASK')) {
    await sleep(${WORKER_THINK_MS});
    return fauxAssistantMessage('I checked the README. Before I record the result, I need your go: reply GO.');
  }
  // A run the owner starts sends no wake; the done report does, so the orchestrator hears about the result.
  if (text === 'GO') {
    return fauxAssistantMessage([fauxToolCall('mcp__pichamber__worker_report', {
      kind: 'done', summary: 'README check passed.', evidence: ['README checked'], noPullRequest: 'lab task', clientRequestId: 'lab-done-' + Date.now(),
    })], { stopReason: 'toolUse' });
  }
  if (text.includes('STATUS')) return fauxAssistantMessage('The worker is still working on the README check. I can answer you meanwhile.');
  if (text.includes('ORCHESTRATE')) {
    const inWorktree = text.includes('WORKTREE');
    return fauxAssistantMessage([fauxToolCall('mcp__pichamber__session_spawn', {
      cwd: inWorktree ? ${JSON.stringify(worktreeWorkerCwd)} : ${JSON.stringify(workerCwd)},
      task: 'WORKER TASK: check the README of this project.',
      title: inWorktree ? ${JSON.stringify(LAB_WORKTREE_WORKER.title)} : ${JSON.stringify(LAB_WORKER_TITLE)},
      model: { providerId: 'faux', modelId: 'faux-1' },
      clientRequestId: 'lab-spawn-' + Date.now(),
    })], { stopReason: 'toolUse' });
  }
  return fauxAssistantMessage('Scripted lab model: send ORCHESTRATE, STATUS, GO, REVIEW or RENDER.');
};

export default function (pi) {
  const faux = fauxProvider();
  faux.setResponses(Array.from({ length: 200 }, () => respond));
  pi.registerProvider(faux.provider);
}
`;
}
