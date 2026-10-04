// Builds a Linux AppImage for local development and installs it at one stable path,
// <main checkout>/packages/electron/dist/dev/PiChamber.AppImage, also when run from a git worktree,
// and copies it to the user's launcher path (~/AppImages/pichamber.appimage unless configured).
// Release packaging stays in package.mjs with versioned names under dist/.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptsDir, '..');
export const DEV_APPIMAGE_NAME = 'PiChamber.AppImage';
export const USER_INSTALL_ENV = 'PICHAMBER_DEV_APPIMAGE_INSTALL_PATH';

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

/**
 * Where the launcher copy goes: ~/AppImages/pichamber.appimage by default (desktop entry, Gear Lever),
 * the path in PICHAMBER_DEV_APPIMAGE_INSTALL_PATH when set (`~/` expands to the home directory),
 * or nowhere when that variable is set but empty.
 */
export function resolveUserInstallPath(env = process.env, home = os.homedir()) {
  const value = env[USER_INSTALL_ENV];
  if (value === undefined) return path.join(home, 'AppImages', 'pichamber.appimage');
  if (value.trim() === '') return null;
  return path.resolve(value.startsWith('~/') ? path.join(home, value.slice(2)) : value);
}

/**
 * Copies the AppImage next to the target first and renames it into place, so a running instance keeps
 * its old image and a failed copy leaves the previous file untouched and no temporary file behind.
 */
export function copyAppImage(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.tmp`);
  try {
    fs.copyFileSync(source, temporary);
    fs.chmodSync(temporary, 0o755);
    fs.renameSync(temporary, target);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
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
    const devImage = installDevAppImage(buildDir, outputDir);
    console.log(`[electron] dev AppImage: ${devImage}`);
    const userTarget = resolveUserInstallPath();
    if (userTarget) {
      try {
        console.log(`[electron] installed: ${copyAppImage(devImage, userTarget)}`);
      } catch (error) {
        throw new Error(`${devImage} is updated, but copying it to ${userTarget} failed: ${error.message}`);
      }
    }
  } finally {
    fs.rmSync(buildDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); } catch (error) { console.error(`[electron] ${error.message}`); process.exitCode = 1; }
}
