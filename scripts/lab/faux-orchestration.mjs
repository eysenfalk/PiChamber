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
// Long enough for the owner to ask the orchestrator something while the worker runs.
const WORKER_THINK_MS = 10000;

/** Source of the extension module the seed writes into the lab agent directory. */
export function fauxOrchestrationExtension({ fauxUrl, workerCwd }) {
  return `import { fauxAssistantMessage, fauxProvider, fauxToolCall } from ${JSON.stringify(fauxUrl)};

const textOf = (message) => typeof message?.content === 'string'
  ? message.content
  : (message?.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\\n');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const respond = async (context) => {
  const last = (context.messages ?? []).filter((message) => message.role !== 'system').at(-1);
  const text = textOf(last).trim();
  if (last?.role === 'toolResult') return fauxAssistantMessage('The worker "${LAB_WORKER_TITLE}" is running. I stay available while it works.');
  if (text.startsWith('Worker "')) {
    return fauxAssistantMessage(text.includes('WORKER DONE')
      ? 'The worker finished: the README check passed. Nothing else is open.'
      : 'The worker waits for your go. Write GO in its session.');
  }
  if (text.includes('WORKER TASK')) {
    await sleep(${WORKER_THINK_MS});
    return fauxAssistantMessage('I checked the README. Before I record the result, I need your go: reply GO.');
  }
  if (text === 'GO') return fauxAssistantMessage('WORKER DONE: the README check passed and is recorded.');
  if (text.includes('STATUS')) return fauxAssistantMessage('The worker is still working on the README check. I can answer you meanwhile.');
  if (text.includes('ORCHESTRATE')) {
    return fauxAssistantMessage([fauxToolCall('mcp__pichamber__session_spawn', {
      cwd: ${JSON.stringify(workerCwd)},
      task: 'WORKER TASK: check the README of this project.',
      title: ${JSON.stringify(LAB_WORKER_TITLE)},
      model: { providerId: 'faux', modelId: 'faux-1' },
      clientRequestId: 'lab-spawn-' + Date.now(),
    })], { stopReason: 'toolUse' });
  }
  return fauxAssistantMessage('Scripted lab model: send ORCHESTRATE, STATUS or GO.');
};

export default function (pi) {
  const faux = fauxProvider();
  faux.setResponses(Array.from({ length: 200 }, () => respond));
  pi.registerProvider(faux.provider);
}
`;
}
