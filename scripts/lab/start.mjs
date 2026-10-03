import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { seedLab } from './seed.mjs';

if (process.env.HOME !== '/lab' || process.env.PI_OFFLINE !== '1') {
  throw new Error('start.mjs runs only inside the offline lab.');
}
const seed = await seedLab('/lab');
for (const path of ['/lab/runtime', '/lab/config', '/lab/cache', '/lab/data']) {
  await mkdir(path, { recursive: true, mode: 0o700 });
}
const child = spawn(process.execPath, ['/repo/packages/web/bin/cli.js', 'serve', '--foreground',
  '--host', '0.0.0.0', '--port', '3000'], { cwd: seed.projects[0].path, stdio: 'inherit' });
let ended = false;
child.once('error', (error) => { console.error(error.message); process.exit(1); });
child.once('exit', (code) => { ended = true; process.exit(process.exitCode ?? code ?? 1); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
const base = 'http://127.0.0.1:3000';
async function request(path, body, method = 'POST') {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}
try {
  let ready = false;
  const deadline = Date.now() + 60000;
  while (!ended && Date.now() < deadline) {
    try {
      const health = await request('/api/pi/runtime', null, 'GET');
      if (health.state === 'ready') { ready = true; break; }
    } catch { /* The supervisor is still starting. The deadline remains authoritative. */ }
    await new Promise((done) => setTimeout(done, 250));
  }
  if (!ready) throw new Error('Lab daemon did not become ready within 60 seconds.');
  // projects.list does not discover session cwds. Register through the same routes as the UI.
  for (const project of seed.projects) await request('/api/pi/projects/select', { directory: project.path });
  await request('/api/pi/projects/select', { directory: seed.projects[0].path });
  const projects = seed.projects.map((project) => ({ id: `lab-${project.name}`, path: project.path, label: project.name }));
  await request('/api/pi/ui-settings', { projects, activeProjectId: projects[0].id,
    lastDirectory: projects[0].path }, 'PUT');
  console.log('Lab ready: synthetic projects and sessions registered.');
} catch (error) {
  console.error(error.message);
  child.kill('SIGTERM');
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 10000).unref();
}
