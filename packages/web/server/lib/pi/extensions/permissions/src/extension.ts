import { getAgentDir, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Key } from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import { createConfigStore } from './config.ts';
import { createPermissionController } from './controller.ts';
import { createInventory } from './inventory.ts';
import { isReadOnlyTool } from './tool-risk.ts';
import { permissionStatus } from './status.ts';
import type { PermissionMode } from './types.ts';

const MODES: PermissionMode[] = ['ask', 'auto', 'yolo'];

/** Composition root. The optional agentDir adapter isolates filesystem tests. */
export default function permissionsExtension(pi: ExtensionAPI, options: { agentDir?: string } = {}): void {
  const store = createConfigStore(options.agentDir ?? getAgentDir());
  const controller = createPermissionController(store);
  const inventory = createInventory(pi, controller.getConfig);
  let activeBeforeReadOnly: string[] | undefined;
  const hints = (name: string) => pi.getAllTools().find(tool => tool.name === name)?.annotations;

  function refresh(ctx: ExtensionContext, reason: string) {
    try { return inventory.refresh(ctx, reason); } catch { return undefined; }
  }
  function publish(ctx: ExtensionContext) {
    const { mode, readOnly } = controller.getConfig();
    ctx.ui.setStatus('permissions', permissionStatus(mode, readOnly, controller.getError()));
  }
  function updateLoadout() {
    const { mode, readOnly } = controller.getConfig();
    if (readOnly && mode !== 'yolo') {
      const active = pi.getActiveTools();
      activeBeforeReadOnly ??= active;
      pi.setActiveTools(active.filter(name => name === 'bash' || isReadOnlyTool(name, hints(name))));
    } else if (activeBeforeReadOnly) {
      pi.setActiveTools([...new Set([...pi.getActiveTools(), ...activeBeforeReadOnly])]);
      activeBeforeReadOnly = undefined;
    }
  }
  function start(_event: unknown, ctx: ExtensionContext) {
    activeBeforeReadOnly = undefined;
    controller.start(ctx);
    updateLoadout();
    publish(ctx);
    refresh(ctx, 'session_start');
    if (controller.getError()) ctx.ui.notify(controller.getError()!, 'error');
  }
  for (const event of ['session_start', 'session_switch', 'session_fork', 'session_tree'] as const) pi.on(event, start);
  pi.on('session_shutdown', (_event, ctx) => { controller.dispose(); ctx.ui.setStatus('permissions', undefined); });
  pi.on('tool_call', async (event, ctx) => {
    const result = await controller.enforce(event, ctx, hints(event.toolName));
    publish(ctx);
    refresh(ctx, 'tool_change');
    return result;
  });
  function setMode(mode: PermissionMode, ctx: ExtensionContext) {
    controller.setMode(mode);
    updateLoadout(); publish(ctx);
    ctx.ui.notify(mode === 'yolo' ? 'Yolo: all custom permission checks are bypassed, including read-only.' : `Permission mode: ${mode}`, mode === 'yolo' ? 'warning' : 'info');
  }
  function setReadOnly(enabled: boolean, ctx: ExtensionContext) {
    controller.setReadOnly(enabled);
    updateLoadout(); publish(ctx);
    const bypassed = controller.getConfig().mode === 'yolo' && enabled;
    ctx.ui.notify(`Read-only ${enabled ? 'on' : 'off'}${bypassed ? ' (bypassed by yolo)' : ''}`, enabled ? 'warning' : 'info');
  }
  pi.registerShortcut(Key.alt('n'), { description: 'Cycle permission mode', handler: async ctx => {
    const index = MODES.indexOf(controller.getConfig().mode);
    setMode(MODES[(index + 1) % MODES.length], ctx);
  } });
  pi.registerShortcut(Key.alt('r'), { description: 'Toggle read-only override', handler: async ctx => setReadOnly(!controller.getConfig().readOnly, ctx) });
  pi.registerCommand('permissions', {
    description: 'Permission mode and inventory: status, tools, ask, auto, yolo',
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (MODES.includes(action as PermissionMode)) { setMode(action as PermissionMode, ctx); return; }
      controller.load(ctx); publish(ctx);
      if (action === 'tools' || action === 'refresh-tools') {
        const result = refresh(ctx, action);
        ctx.ui.notify(result ? inventory.format(result) : 'Tool inventory unavailable', result ? 'info' : 'error');
        return;
      }
      ctx.ui.notify([
        `Mode: ${controller.getConfig().mode}`,
        `Read-only: ${controller.getConfig().readOnly ? 'on' : 'off'}${controller.getConfig().mode === 'yolo' ? ' (bypassed)' : ''}`,
        `Config: ${store.path}`,
        `Repo config: ${controller.getConfig().repo?.path ?? 'none'}`,
        `Session allowances: ${controller.getAllowanceCount()}`,
        controller.getError() ?? 'Best-effort tool-call gate, not an OS sandbox.',
      ].join('\n'), controller.getError() ? 'error' : 'info');
    },
  });
  pi.registerCommand('read-only', {
    description: 'Read-only override: on, off, status, or toggle',
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (action === 'status') { publish(ctx); return; }
      if (!['', 'toggle', 'on', 'off'].includes(action)) { ctx.ui.notify('Use /read-only on, off, status, or toggle', 'error'); return; }
      setReadOnly(action === 'on' ? true : action === 'off' ? false : !controller.getConfig().readOnly, ctx);
    },
  });
  pi.registerTool({
    name: 'permissions_tool_inventory', label: 'Permissions Tool Inventory',
    description: 'Inspect registered Pi tools, schemas, active state, and permission summaries.',
    parameters: Type.Object({ full: Type.Optional(Type.Boolean()), tool: Type.Optional(Type.String()), includeInactive: Type.Optional(Type.Boolean()) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const result = inventory.refresh(ctx, 'tool_inventory');
      const data = inventory.select(result, params);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], details: data };
    },
  });
}
