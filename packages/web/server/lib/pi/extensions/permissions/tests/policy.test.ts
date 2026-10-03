import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultConfig, createConfigStore } from '../src/config.ts';
import { modeResolve, normalizeAction, normalizeConfiguredRuleSet } from '../src/actions.ts';
import { collectChecks, createRuleCheck, readOnlyBlockReason } from '../src/checks.ts';
import { collectPathInputs } from '../src/paths.ts';
import { isReadOnlyTool, isReadOnlyBashCommand } from '../src/tool-risk.ts';
import { createPermissionController } from '../src/controller.ts';
import { askForApproval } from '../src/approvals.ts';
import { permissionStatus } from '../src/status.ts';

const root = () => mkdtempSync(path.join(tmpdir(), 'pi-permissions-policy-'));
function fixture(raw?: unknown) {
  const dir = root(); const cwd = path.join(dir, 'workspace'); mkdirSync(cwd);
  const store = createConfigStore(path.join(dir, 'agent'));
  if (raw) store.save(raw as Record<string, unknown>);
  const replies: (string | undefined)[] = []; const prompts: unknown[] = [];
  const ctx = { cwd, signal: undefined, hasUI: true, ui: { select: async (title: string, choices: string[], opts: unknown) => { prompts.push({ title, choices, opts }); return replies.shift(); } } } as any;
  const controller = createPermissionController(store); controller.start(ctx);
  return { cwd, store, ctx, controller, replies, prompts };
}

test('all four levels retain ask/auto semantics, while yolo bypasses everything', () => {
  const levels = ['allow','ask','confirm','forbid'] as const;
  assert.deepEqual(levels.map(a => modeResolve('ask', a)), ['allow','ask','ask','block']);
  assert.deepEqual(levels.map(a => modeResolve('auto', a)), ['allow','allow','ask','block']);
  assert.deepEqual(levels.map(a => modeResolve('yolo', a)), ['allow','allow','allow','allow']);
  assert.equal(normalizeAction('denied'), 'confirm'); assert.equal(normalizeAction('allowed'), 'allow');
  assert.deepEqual(normalizeConfiguredRuleSet({ 'echo *':'allow' }, { '*':'ask' }), { 'echo *':'allow' });
});
test('last matching glob wins and repo rules can only tighten', () => {
  const rule = (global: any, repo?: any) => createRuleCheck('tool','write',global,'ask','write','write',repo).action;
  assert.equal(rule({ '*':'ask', write:'allow' }), 'allow');
  assert.equal(rule({ write:'allow', '*':'forbid' }), 'forbid');
  assert.equal(rule({ write:'forbid' }, { write:'allow' }), 'forbid');
  assert.equal(rule({ write:'allow' }, { write:'confirm' }), 'confirm');
});
test('current cmd inputs and native Confluence names are confirm-gated', () => {
  const cfg = defaultConfig(); const cwd = root();
  assert.ok(collectChecks(cfg, { toolName:'bash', input:{cmd:'ssh host'} }, {cwd}).some(c => c.category === 'command' && c.action === 'confirm'));
  assert.ok(collectChecks(cfg, { toolName:'powershell', input:{cmd:'ssh host'} }, {cwd}).some(c => c.action === 'confirm'));
  for (const method of ['confluence_create_page','confluence_update_page']) assert.equal(collectChecks(cfg, {toolName:`mcp__atlassian_confluence_write__${method}`}, {cwd})[0].action, 'confirm');
});
test('AFT mutation destination/files and selected nested inputs reach path rules', () => {
  assert.deepEqual(collectPathInputs({filePath:'a',destination:'b',files:['c'],edits:[{file_path:'d'}],text:'not-a-path'}), ['a','b','c','d']);
  const cfg = defaultConfig(); cfg.permission.paths.write = {'*':'allow','blocked':'forbid'};
  const checks = collectChecks(cfg, {toolName:'mcp__aft_pi__aft_move',input:{filePath:'from',destination:'blocked'}}, {cwd:root()});
  assert.ok(checks.some(c => c.category === 'write-path' && c.target === 'blocked' && c.action === 'forbid'));
});
test('existing and dangling symlink targets cannot skip secret/outside path checks', () => {
  const cwd=root(); const outside=root(); writeFileSync(path.join(outside,'.env'),'fixture');
  symlinkSync(path.join(outside,'.env'),path.join(cwd,'alias'));
  symlinkSync(path.join(outside,'missing.env'),path.join(cwd,'dangling'));
  for (const name of ['alias','dangling']) {
    const checks=collectChecks(defaultConfig(),{toolName:'write',input:{path:name}},{cwd});
    assert.ok(checks.some(c=>c.category==='outside-workspace'));
    assert.ok(checks.some(c=>c.category==='write-path' && c.action==='confirm'));
  }
});
test('read-only covers known tools and hints, blocks mutation/unknown/delegation', () => {
  assert.equal(isReadOnlyTool('mcp__aft_pi__aft_outline'),true);
  assert.equal(isReadOnlyTool('arbitrary', {readOnlyHint:true}),true);
  assert.equal(isReadOnlyTool('mcp__awx__get_jobs'),true);
  assert.equal(isReadOnlyTool('unknown_search_delete'),false);
  assert.equal(isReadOnlyTool('read', {readOnlyHint:false}),false);
  assert.ok(readOnlyBlockReason({toolName:'subagent'}));
  assert.ok(readOnlyBlockReason({toolName:'mcp__atlassian_confluence_write__confluence_create_page'}));
  assert.equal(readOnlyBlockReason({toolName:'bash',input:{cmd:'git status'}}),undefined);
  for (const cmd of ['echo hi; touch x','git branch -D main','git remote add x url','find . -delete','cat x > y','echo $(touch x)','awk \'BEGIN { system("touch x") }\'']) assert.equal(isReadOnlyBashCommand(cmd),false,cmd);
});
test('no UI, denied/cancelled/forged choices do not approve Confluence', async () => {
  for (const reply of [undefined,'Denied','not offered']) {
    const f=fixture(); f.replies.push(reply);
    assert.equal((await f.controller.enforce({toolName:'mcp__atlassian_confluence_write__confluence_create_page'},f.ctx))?.block,true);
  }
  const f=fixture(); f.ctx.hasUI=false; f.replies.push('Allow once');
  assert.equal((await f.controller.enforce({toolName:'mcp__atlassian_confluence_write__confluence_update_page'},f.ctx))?.block,true);
  assert.equal(f.prompts.length,0);
});
test('one-shot, session, global allowances work without weakening forbid or unrelated defaults', async () => {
  const call={toolName:'mcp__atlassian_confluence_write__confluence_create_page'};
  const once=fixture(); once.replies.push('Allow once'); assert.equal(await once.controller.enforce(call,once.ctx),undefined);
  assert.equal((await once.controller.enforce(call,once.ctx))?.block,true);
  const session=fixture(); session.replies.push('Always allow this session');
  assert.equal(await session.controller.enforce(call,session.ctx),undefined); assert.equal(await session.controller.enforce(call,session.ctx),undefined);
  session.controller.start(session.ctx); assert.equal((await session.controller.enforce(call,session.ctx))?.block,true);
  const global=fixture(); global.replies.push('Always allow globally'); assert.equal(await global.controller.enforce(call,global.ctx),undefined);
  assert.equal(await global.controller.enforce(call,global.ctx),undefined);
  assert.equal(global.store.load().permission.commands['ssh *'],'confirm');
  const forbidden=fixture({permission:{tools:{[call.toolName]:'forbid'}}}); forbidden.replies.push('Always allow this session');
  assert.equal((await forbidden.controller.enforce(call,forbidden.ctx))?.block,true); assert.equal(forbidden.prompts.length,0);
});
test('global command allowance clears repeated global heuristics but not repo tightening', async () => {
  const f=fixture(); f.replies.push('Always allow globally');
  const call={toolName:'bash',input:{cmd:'ssh host'}};
  assert.equal(await f.controller.enforce(call,f.ctx),undefined);
  assert.equal(await f.controller.enforce(call,f.ctx),undefined);
  mkdirSync(path.join(f.cwd,'.pi')); writeFileSync(path.join(f.cwd,'.pi','permissions.json'),JSON.stringify({permission:{commands:{'ssh *':'forbid'}},mode:'yolo'}));
  assert.equal((await f.controller.enforce(call,f.ctx))?.block,true);
});
test('corrupt config blocks outside yolo and never gets overwritten by allowance persistence', async () => {
  const f=fixture(); mkdirSync(path.dirname(f.store.path),{recursive:true}); writeFileSync(f.store.path,'{broken');
  assert.equal((await f.controller.enforce({toolName:'read',input:{path:'a'}},f.ctx))?.block,true);
  assert.throws(()=>f.store.allowGlobally([])); assert.equal(readFileSync(f.store.path,'utf8'),'{broken');
  f.controller.setReadOnly(true); f.controller.setMode('yolo');
  assert.equal(await f.controller.enforce({toolName:'write',input:{path:'/not-even-a-valid-parent'}},f.ctx),undefined);
  f.controller.start(f.ctx); assert.equal((await f.controller.enforce({toolName:'write'},f.ctx))?.block,true);
});
test('numeric config and invalid rule actions fail closed', () => {
  for (const raw of [123,{permission:{tools:{write:'typo'}}}]) {
    const f=fixture(); mkdirSync(path.dirname(f.store.path),{recursive:true}); writeFileSync(f.store.path,JSON.stringify(raw));
    assert.throws(()=>f.store.load(f.cwd));
  }
});
test('read-only blocks mutation, but yolo bypasses it and forbid', async () => {
  const f=fixture({readOnly:true,permission:{tools:{write:'forbid'}}});
  assert.equal((await f.controller.enforce({toolName:'write'},f.ctx))?.block,true);
  f.controller.setMode('yolo'); assert.equal(await f.controller.enforce({toolName:'write'},f.ctx),undefined);
  assert.equal(permissionStatus('yolo',true),'permissions/v1 mode=yolo readOnly=on');
});
test('deadline, operation abort and stale-policy cancellation deny without UI cooperation', async () => {
  const f=fixture(); const local=new AbortController(); let passed: any;
  f.ctx.ui.select=async (_:unknown,__:unknown,opts:unknown)=>{passed=opts;return new Promise(()=>{});};
  assert.equal(await askForApproval(f.ctx,[],local.signal,5),'Denied'); assert.equal(passed.signal.aborted,true);
  const pending=askForApproval(f.ctx,[],local.signal,1000); local.abort(); assert.equal(await pending,'Denied');
  const call=f.controller.enforce({toolName:'mcp__atlassian_confluence_write__confluence_create_page'},f.ctx);
  f.controller.setMode('yolo'); assert.equal((await call)?.block,true);
});
