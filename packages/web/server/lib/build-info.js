import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const BUILD_INFO_FILE = 'build-info.json';

const SOURCE_BUILD_PREFIX = 'source';
const BUILD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const defaultRunGit = (args, cwd) => execFileSync('git', args, {
  cwd,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'ignore'],
  timeout: 10_000,
}).trim();

/**
 * Short Git commit of `cwd`, plus `-dirty` when tracked files differ from
 * HEAD. Untracked files do not count: build outputs and local tooling
 * directories are untracked in normal use. Returns `unknown` outside a
 * Git checkout instead of inventing an ID.
 */
export const readGitBuildId = ({ cwd, runGit = defaultRunGit } = {}) => {
  try {
    const commit = runGit(['rev-parse', '--short', 'HEAD'], cwd);
    if (!/^[0-9a-f]{4,40}$/.test(commit)) return 'unknown';
    const dirty = runGit(['status', '--porcelain', '--untracked-files=no'], cwd).length > 0;
    return dirty ? `${commit}-dirty` : commit;
  } catch {
    return 'unknown';
  }
};

/**
 * The stamp of one build: Git-derived ID and the UTC build time. Two builds
 * of the same commit share the ID and differ in `builtAt`.
 */
export const createBuildStamp = ({ cwd, now = new Date(), runGit } = {}) => ({
  id: readGitBuildId({ cwd, runGit }),
  builtAt: now.toISOString(),
});

export const isBuildStamp = (value) => Boolean(
  value
  && typeof value === 'object'
  && typeof value.id === 'string'
  && BUILD_ID_PATTERN.test(value.id)
  && typeof value.builtAt === 'string'
  && Number.isFinite(Date.parse(value.builtAt)),
);

/** Reads the stamp the Vite build wrote next to the served UI; null when absent or malformed. */
export const readBuildStamp = (distDir) => {
  try {
    const stamp = JSON.parse(readFileSync(join(distDir, BUILD_INFO_FILE), 'utf8'));
    return isBuildStamp(stamp) ? { id: stamp.id, builtAt: stamp.builtAt } : null;
  } catch {
    return null;
  }
};

/**
 * The running server's build. A checkout without a build has no build time to
 * report, so it identifies itself as `source-<commit>` and uses the server
 * start time, flagged by `kind: 'source'`.
 */
export const resolveServerBuild = ({ distDir, cwd, startedAt, runGit } = {}) => {
  const stamp = readBuildStamp(distDir);
  if (stamp) return { ...stamp, kind: 'build' };
  return {
    id: `${SOURCE_BUILD_PREFIX}-${readGitBuildId({ cwd, runGit })}`,
    builtAt: startedAt,
    kind: 'source',
  };
};
