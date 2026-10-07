import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';
const root = process.env.PI_SDK_ROOT;
if (!root) throw new Error('Set PI_SDK_ROOT to a directory with the installed Pi SDK and TypeScript in node_modules');
const require = createRequire(join(resolve(root), 'package.json'));
const ts = require('typescript');
const sdk = join(root, 'node_modules/@earendil-works/pi-coding-agent/dist/index.js');
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const paths = Object.fromEntries(['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui', 'typebox'].map(name => {
  const resolved = ts.resolveModuleName(name, sdk, {module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler},ts.sys).resolvedModule;
  if (!resolved) throw new Error(`Cannot resolve installed SDK dependency ${name}`);
  return [name,[resolved.resolvedFileName]];
}));
const program = ts.createProgram(readdirSync(dir).filter(name=>name.endsWith('.ts')).map(name=>join(dir,name)), {
  noEmit:true, strict:true, skipLibCheck:true, noUnusedLocals:true, noUnusedParameters:true,
  target:ts.ScriptTarget.ES2022, module:ts.ModuleKind.ESNext, moduleResolution:ts.ModuleResolutionKind.Bundler,
  allowImportingTsExtensions:true, baseUrl:root, paths, types:['node'], typeRoots:[join(root,'node_modules/@types')],
});
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) { console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics,{getCurrentDirectory:()=>root,getCanonicalFileName:f=>f,getNewLine:()=> '\n'})); process.exitCode=1; }
else console.log('Permissions native source: strict TypeScript check passed');
