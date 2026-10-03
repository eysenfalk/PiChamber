import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(join(resolve(process.env.PI_SDK_ROOT ?? process.cwd()), 'package.json'));
const sdkPath = require.resolve('@earendil-works/pi-coding-agent');
const sdkRequire = createRequire(sdkPath);
const sdk = await import(pathToFileURL(sdkPath).href);
const { Type } = await import(pathToFileURL(sdkRequire.resolve('typebox')).href);
const source = resolve(dirname(fileURLToPath(import.meta.url)), '../src/extension.ts');

async function fixture({ fabric = false, ui = true } = {}) {
  const root = await mkdtemp(join(tmpdir(),'pi-permissions-sdk-'));
  const cwd = join(root,'workspace'); const agentDir = join(root,'agent');
  await mkdir(cwd); await mkdir(agentDir);
  const entry = join(root,'permissions.ts');
  await writeFile(entry, `import permissions from ${JSON.stringify(source)}; export default pi => permissions(pi, {agentDir:${JSON.stringify(agentDir)}});\n`);
  const settingsManager = sdk.SettingsManager.inMemory({packages:[],extensions:[],compaction:{enabled:false}});
  const effects=[]; const replies=[]; const statuses=new Map(); const errors=[];
  const probe = pi => {
    pi.registerTool({name:'mcp__atlassian_confluence_write__confluence_create_page',label:'Local fake Confluence write',description:'Local counter only; no network',parameters:Type.Object({}),execute:async()=>{effects.push('write');return{content:[{type:'text',text:'local fake executed'}],details:{}};}});
    pi.registerTool({name:'native_nested_probe',label:'Nested permission probe',description:'Local middleware probe',parameters:Type.Object({}),execute:async(_id,_args,_signal,_update,ctx)=>({content:[{type:'text',text:'nested probe'}],details:{outcome:await ctx.executeTool('mcp__atlassian_confluence_write__confluence_create_page',{})}})});
  };
  const loader = new sdk.DefaultResourceLoader({cwd,agentDir,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,additionalExtensionPaths:[entry,...(fabric?[process.env.PI_FABRIC_ENTRY]:[])],extensionFactories:[probe]});
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors,[],'actual SDK extension loading');
  const {session} = await sdk.createAgentSession({cwd,agentDir,settingsManager,resourceLoader:loader,sessionManager:sdk.SessionManager.inMemory(cwd)});
  let bridge;
  let uiContext = ui ? {select:async()=>replies.shift(),notify:()=>{},setStatus:(key,value)=>value===undefined?statuses.delete(key):statuses.set(key,value)} : undefined;
  if (process.env.PI_CHAMBER_ROOT && ui) {
    const {createExtensionBridge}=await import(pathToFileURL(join(process.env.PI_CHAMBER_ROOT,'packages/web/server/lib/pi/session-daemon/extension-bridge.js')).href);
    bridge=createExtensionBridge({publish:(event,payload)=>{if(event==='extension.dialog')void bridge.resolveExtensionDialog({requestId:payload.requestId,sessionId:session.sessionId,value:replies.shift()??'Denied'});},resolveDirectory:async v=>v,getDefaultDirectory:()=>cwd,findRuntimeBySessionId:()=>({cwd}),protocolError:(code,message)=>Object.assign(new Error(message),{code})});
    uiContext=bridge.buildExtensionBindings(session).uiContext;
  }
  await session.bindExtensions({mode:ui?'rpc':'print',...(uiContext?{uiContext}:{}),onError:e=>errors.push(e)});
  const tool = name => {const item=session.agent.state.tools.find(t=>t.name===name);assert.ok(item,`registered and active tool: ${name}`);return item;};
  const execute = async(name,args={})=>tool(name).execute(`probe-${Math.random()}`,args,new AbortController().signal,()=>{});
  return {cwd,session,effects,replies,statuses,errors,bridge,tool,execute};
}

test('real SDK loads commands/inventory and gates direct+nested local writes through native middleware', async()=>{
  const f=await fixture();
  try {
    assert.equal(f.session.getCommands().some(command=>command.name==='permissions'),true);
    const liveStatus=()=>f.bridge?.getSnapshotState(f.session.sessionId).statuses?.find(status=>status.key==='permissions')?.text??f.statuses.get('permissions');
    assert.equal(liveStatus(),'permissions/v1 mode=auto readOnly=off');
    const inventory=await f.execute('permissions_tool_inventory',{tool:'mcp__atlassian_confluence_write__confluence_create_page'});
    assert.match(JSON.stringify(inventory),/confirm/);
    try { await f.execute('mcp__atlassian_confluence_write__confluence_create_page'); } catch(error) { assert.match(String(error),/permission|denied/i); }
    assert.equal(f.effects.length,0,'denial prevents actual tool execute');
    const nested=await f.execute('native_nested_probe');
    assert.equal(nested.details.outcome.isError,true); assert.equal(f.effects.length,0,'native ctx.executeTool is guarded');
    f.replies.push('Allow once'); await f.execute('mcp__atlassian_confluence_write__confluence_create_page'); assert.equal(f.effects.length,1);
    await f.session.prompt('/read-only on'); assert.equal(liveStatus(),'permissions/v1 mode=auto readOnly=on');
    await f.session.prompt('/permissions yolo'); assert.equal(liveStatus(),'permissions/v1 mode=yolo readOnly=on');
    await f.execute('mcp__atlassian_confluence_write__confluence_create_page'); assert.equal(f.effects.length,2,'unrestricted yolo restores exposure and bypasses read-only');
    await f.session.prompt('/read-only off'); await f.session.prompt('/permissions ask');
    assert.equal(liveStatus(),'permissions/v1 mode=ask readOnly=off');
    assert.deepEqual(f.errors,[]);
  } finally {f.bridge?.clearExtensionState(f.session.sessionId);f.session.dispose();}
});

test('real SDK without UI refuses confirm-gated native MCP execution',async()=>{
  const f=await fixture({ui:false});
  try {try {await f.execute('mcp__atlassian_confluence_write__confluence_create_page');}catch(error){assert.match(String(error),/permission|denied/i);} assert.equal(f.effects.length,0);assert.deepEqual(f.errors,[]);}
  finally {f.session.dispose();}
});

test('installed Fabric nested pi.write honors native path permission middleware',{skip:!process.env.PI_FABRIC_ENTRY},async()=>{
  const f=await fixture({fabric:true});
  try {
    const target=join(f.cwd,'blocked.env'); const code=`return await pi.write({path:${JSON.stringify(target)},text:'local fixture'});`;
    try {await f.execute('fabric_exec',{code});}catch(error){assert.match(String(error),/permission|denied|confirm|blocked/i);}
    await assert.rejects(access(target),'denied nested core write did not reach filesystem');
    await f.session.prompt('/permissions yolo'); await f.execute('fabric_exec',{code}); await access(target);
    assert.deepEqual(f.errors,[]);
  } finally {f.bridge?.clearExtensionState(f.session.sessionId);f.session.dispose();}
});
