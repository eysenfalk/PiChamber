import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { AskChoice, PermissionCheck } from './types.ts';

export const APPROVAL_TIMEOUT_MS = 120_000;
const CHOICES: AskChoice[] = ['Allow once', 'Always allow this session', 'Always allow globally', 'Denied'];
export type ApprovalContext = Pick<ExtensionContext, 'hasUI' | 'ui' | 'signal'>;

/** Fail closed even if a host fails to implement dialog timeouts/cancellation. */
export async function askForApproval(ctx: ApprovalContext, checks: PermissionCheck[], scope: AbortSignal, timeout = APPROVAL_TIMEOUT_MS): Promise<AskChoice> {
  if (!ctx.hasUI || scope.aborted || ctx.signal?.aborted) return 'Denied';
  const local = new AbortController();
  const signal = AbortSignal.any([scope, local.signal, ...(ctx.signal ? [ctx.signal] : [])]);
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<AskChoice>((resolve) => {
    onAbort = () => resolve('Denied');
    signal.addEventListener('abort', onAbort, { once: true });
  });
  const timer = setTimeout(() => local.abort(), timeout);
  try {
    const lines = checks.map(check => `- ${check.reason} [${check.action}; rule ${check.pattern}]`).join('\n');
    const answer = await Promise.race([
      ctx.ui.select(`Permission required:\n\n${lines}\n\nAllow this action?`, CHOICES, { signal, timeout }),
      cancelled,
    ]);
    return !signal.aborted && CHOICES.includes(answer as AskChoice) ? answer as AskChoice : 'Denied';
  } catch {
    return 'Denied';
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
    local.abort();
  }
}
