import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { PermissionConfig, PermissionMode } from './types.ts';
import { defaultConfig, type createConfigStore } from './config.ts';
import { applySessionAllows, modeResolve, sessionKey } from './actions.ts';
import { collectChecks, collectReadOnlyChecks, readOnlyBlockReason } from './checks.ts';
import { askForApproval } from './approvals.ts';
import type { ToolHints } from './tool-risk.ts';

type Context = Pick<ExtensionContext, 'cwd' | 'ui' | 'hasUI' | 'signal'>;
type Call = { toolName: string; input?: unknown };
const block = (reason: string) => ({ block: true as const, reason });

/** Session-owned policy state; no rendering, OpenSpec, or execution effects. */
export function createPermissionController(store: ReturnType<typeof createConfigStore>) {
  let config = defaultConfig();
  let scope = new AbortController();
  const sessionAllows = new Set<string>();
  let error: string | undefined;
  const invalidate = () => { scope.abort(); scope = new AbortController(); };
  function load(ctx: Context, preserve = true) {
    try {
      const next = store.load(ctx.cwd);
      if (preserve) { next.mode = config.mode; next.readOnly = config.readOnly; }
      if (JSON.stringify(next) !== JSON.stringify(config)) { invalidate(); sessionAllows.clear(); }
      config = next;
      error = undefined;
    } catch (cause) {
      invalidate();
      error = String(cause instanceof Error ? cause.message : cause);
    }
  }
  function start(ctx: Context) { invalidate(); sessionAllows.clear(); config = defaultConfig(); load(ctx, false); }
  function setMode(mode: PermissionMode) { invalidate(); config.mode = mode; }
  function setReadOnly(value: boolean) { invalidate(); config.readOnly = value; }
  async function enforce(event: Call, ctx: Context, hints?: ToolHints) {
    // Intentionally before reload, read-only, paths, forbid, and all other checks.
    if (config.mode === 'yolo') return undefined;
    load(ctx);
    if (error) return block(error);
    if (ctx.signal?.aborted) return block('Permission operation aborted');
    if (config.readOnly) {
      const reason = readOnlyBlockReason(event, hints);
      if (reason) return block(reason);
    }
    const checks = (config.readOnly ? collectReadOnlyChecks : collectChecks)(config, event, ctx)
      .map(check => applySessionAllows(check, sessionAllows));
    const mode = config.readOnly ? 'ask' : config.mode;
    const forbidden = checks.filter(check => modeResolve(mode, check.action) === 'block');
    if (forbidden.length) return block(forbidden.map(check => check.reason).join('\n'));
    const asking = checks.filter(check => modeResolve(mode, check.action) === 'ask');
    if (!asking.length) return undefined;
    const operationScope = scope.signal;
    const choice = await askForApproval(ctx, asking, operationScope);
    if (operationScope.aborted || ctx.signal?.aborted) return block('Permission approval expired or operation aborted');
    // Re-read before execution: a human answer cannot authorize different rules.
    load(ctx);
    if (error || operationScope.aborted) return block(error ?? 'Permissions changed while awaiting approval');
    if (choice === 'Allow once') return undefined;
    if (choice === 'Always allow this session') {
      for (const check of asking) sessionAllows.add(sessionKey(check));
      return undefined;
    }
    if (choice === 'Always allow globally') {
      try { store.allowGlobally(asking); } catch (cause) { return block(`Cannot save permission allowance: ${cause}`); }
      return undefined;
    }
    return block('Denied by user, cancellation, or approval timeout');
  }
  return { start, load, enforce, setMode, setReadOnly, dispose: invalidate,
    getConfig: (): PermissionConfig => config,
    getError: () => error,
    getAllowanceCount: () => sessionAllows.size,
  };
}
