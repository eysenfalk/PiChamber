import { spawnSync } from 'node:child_process';

// A PiChamber/Electron parent must not select its installed assets, password or daemon for tests.
export function isolatedTestEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) =>
    !key.startsWith('PICHAMBER_') && !['PICHAMBER', 'PI_PACKAGE_DIR', 'ELECTRON_RUN_AS_NODE'].includes(key)));
}

if (process.argv[2] === '--run') {
  for (const suite of ['test:repo', 'test:tools', 'test:web', 'test:ui', 'test:electron']) {
    const result = spawnSync('bun', ['run', suite], { env: isolatedTestEnv(process.env), stdio: 'inherit' });
    if (result.error) { console.error(result.error.message); process.exit(1); }
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
