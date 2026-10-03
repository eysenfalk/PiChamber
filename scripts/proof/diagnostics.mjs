import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function diagnosticUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.origin + url.pathname : url.protocol;
  } catch { return '[unavailable]'; }
}

// Record only synthetic lab/fixture pages. Strip credential carriers before truncation.
export function diagnosticText(value, limit = 4096) {
  return String(value ?? '')
    .replace(/https?:\/\/[^\s<>"']+/g, url => diagnosticUrl(url))
    .replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [redacted]')
    .replace(/(["']?(?:[\w-]*(?:token|secret|password|credential|authorization|cookie|api[_-]?key)[\w-]*)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi, '$1[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?\b/g, '[redacted]')
    .replace(/\b[A-Za-z0-9_+=-]{40,}\b/g, '[redacted]')
    .slice(0, limit);
}

const stackText = stack => (stack?.callFrames ?? []).slice(0, 20).map(frame =>
  (frame.functionName || '(anonymous)') + ' at ' + diagnosticUrl(frame.url) + ':' + (frame.lineNumber + 1) + ':' + (frame.columnNumber + 1)).join('\n');
const argumentText = arg => typeof arg.value === 'string' ? arg.value : arg.type === 'object' && arg.subtype !== 'error' ? '[object omitted]' : arg.description ?? arg.value ?? arg.type;

export function createPageDiagnostics() {
  const events = [];
  let omittedEvents = 0;
  const add = (source, text) => {
    if (events.length === 50) { events.shift(); omittedEvents++; }
    events.push({ source, text: diagnosticText(text) });
  };
  return {
    handlers: {
      'Runtime.exceptionThrown': event => {
        const details = event.exceptionDetails;
        add('Runtime.exceptionThrown', [details.exception?.description || details.text, stackText(details.stackTrace)].filter(Boolean).join('\n'));
      },
      'Log.entryAdded': ({ entry }) => {
        if (entry.level === 'error') add('Log.entryAdded', [entry.text, entry.url && diagnosticUrl(entry.url), stackText(entry.stackTrace)].filter(Boolean).join('\n'));
      },
      'Runtime.consoleAPICalled': event => {
        if (event.type === 'error') add('console.error', [...event.args.slice(0, 10).map(argumentText), stackText(event.stackTrace)].join('\n'));
      },
    },
    snapshot: page => ({ url: diagnosticUrl(page?.url), errorBoundaryDetails: diagnosticText(page?.errorBoundaryDetails, 8192), events: events.map(event => ({ ...event })), omittedEvents }),
  };
}

// The boundary's <pre> text exists even while its <details> is closed. Do not click
// or dump the whole DOM: neither action is needed to collect its component stack.
export function failurePageDetails() {
  const details = [...document.querySelectorAll('details')].filter(element =>
    element.querySelector('summary')?.textContent.trim() === 'Error details');
  return { url: location.href, errorBoundaryDetails: details.slice(0, 3).map(element =>
    element.querySelector('pre')?.textContent.slice(0, 8192) ?? '').join('\n').slice(0, 8192) };
}

export async function captureFailureDiagnostics(collector, evaluate, fallbackUrl) {
  try { return collector.snapshot(await evaluate('(' + failurePageDetails.toString() + ')()')); }
  catch (error) { return { ...collector.snapshot({ url: fallbackUrl }), captureError: diagnosticText(error.message) }; }
}

export async function writeFailureReport(out, report, diagnostics) {
  const diagnosticFile = String(report.step).padStart(2, '0') + '-not-proven.json';
  await writeFile(join(out, diagnosticFile), JSON.stringify(diagnostics, null, 2) + '\n');
  await writeFile(join(out, 'report.json'), JSON.stringify({ ...report, error: diagnosticText(report.error), diagnosticFile, diagnostics }, null, 2) + '\n');
}
