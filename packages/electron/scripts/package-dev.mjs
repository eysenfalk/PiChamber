// Builds a Linux AppImage for local development and installs it at one stable path,
// <main checkout>/packages/electron/dist/dev/PiChamber.AppImage, also when run from a git worktree.
// Release packaging stays in package.mjs with versioned names under dist/.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptsDir, '..');
export const DEV_APPIMAGE_NAME = 'PiChamber.AppImage';

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/**
 * dist/dev of this package inside the main checkout. A linked worktree shares the main checkout's
 * git directory, so its builds land in the same place. Outside git, or when the common git directory
 * is not a checkout's .git (bare repository), the package's own dist/dev is used.
 */
export function resolveDevOutputDir(cwd = packageDir) {
  let commonDir;
  let prefix;
  try {
    commonDir = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    prefix = git(cwd, ['rev-parse', '--show-prefix']);
  } catch {
    return path.join(cwd, 'dist', 'dev');
  }
  if (path.basename(commonDir) !== '.git') return path.join(cwd, 'dist', 'dev');
  return path.join(path.dirname(commonDir), prefix, 'dist', 'dev');
}

/**
 * Moves the single AppImage out of a finished build directory onto the stable path. rename() replaces
 * the directory entry atomically, so a running instance keeps reading its old inode and a failed build
 * never leaves a partial file behind.
 */
export function installDevAppImage(buildDir, outputDir) {
  const images = fs.readdirSync(buildDir).filter((name) => name.endsWith('.AppImage'));
  if (images.length !== 1) throw new Error(`Expected one AppImage in ${buildDir}, found ${images.length}`);
  const source = path.join(buildDir, images[0]);
  const target = path.join(outputDir, DEV_APPIMAGE_NAME);
  fs.chmodSync(source, 0o755);
  fs.renameSync(source, target);
  return target;
}

function main() {
  if (process.platform !== 'linux') throw new Error('Dev AppImage builds are Linux only; use "bun run electron:build" elsewhere.');
  const outputDir = resolveDevOutputDir();
  fs.mkdirSync(outputDir, { recursive: true });
  // Same filesystem as the target, so the final rename stays atomic.
  const buildDir = fs.mkdtempSync(path.join(outputDir, '.build-'));
  try {
    const result = spawnSync(process.execPath, [path.join(scriptsDir, 'package.mjs'), '--linux', 'AppImage', '--publish=never',
      `-c.directories.output=${buildDir}`, ...process.argv.slice(2)], { cwd: packageDir, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`electron-builder failed (exit ${result.status ?? result.signal}); ${path.join(outputDir, DEV_APPIMAGE_NAME)} is unchanged`);
    console.log(`[electron] dev AppImage: ${installDevAppImage(buildDir, outputDir)}`);
  } finally {
    fs.rmSync(buildDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); } catch (error) { console.error(`[electron] ${error.message}`); process.exitCode = 1; }
}
