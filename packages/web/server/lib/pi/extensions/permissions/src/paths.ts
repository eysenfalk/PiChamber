import { homedir } from 'node:os';
import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import path from 'node:path';

export function resolveInputPath(inputPath: string, cwd: string): string {
	if (inputPath === "~") return homedir();
	if (inputPath.startsWith("~/"))
		return path.join(homedir(), inputPath.slice(2));
	if (path.isAbsolute(inputPath)) return path.resolve(inputPath);
	return path.resolve(cwd, inputPath);
}

export function displayPath(absPath: string, cwd: string): string {
	const relative = path.relative(cwd, absPath).split(path.sep).join("/");
	if (relative && !isOutsideWorkspace(absPath, cwd) && !path.isAbsolute(relative))
		return relative;
	const home = homedir();
	if (absPath === home) return "~";
	if (absPath.startsWith(`${home}${path.sep}`))
		return `~/${path.relative(home, absPath).split(path.sep).join("/")}`;
	return absPath.split(path.sep).join("/");
}

export function isOutsideWorkspace(absPath: string, cwd: string): boolean {
	const relative = path.relative(cwd, absPath);
	return relative === ""
		? false
		: relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

export function commandPathReferences(command: string): string[] {
	const matches =
		command.match(
			/(?:~\/?[\w.\-/]*|\.\.\/[\w.\-/]+|\.[/\\][\w.\-/]+|\/[\w.\-/]+)/g,
		) ?? [];
	return matches.filter((match) => match.length > 1 && !match.startsWith("//"));
}

export function commandHasWorkspaceEscape(command: string): boolean {
	return (
		/(^|[;&|\s])(?:cd|pushd|git\s+-C|make\s+-C|npm\s+--prefix|pnpm\s+--dir)\s+(~|\.\.|\/)/i.test(
			command,
		) || /(^|[;&|\s])(?:tar|zip|unzip|rsync|scp|sftp)\b/i.test(command)
	);
}

/**
 * Tool inputs that carry paths. Keys are compared after lowercasing and
 * stripping separators, so `filePath`, `file_path`, and `filepath` all match;
 * a missed key would silently skip every read/write path rule.
 */
const PATH_INPUT_KEYS = new Set([
	"path",
	"paths",
	"file",
	"files",
	"filename",
	"filenames",
	"filepath",
	"filepaths",
	"root",
	"roots",
	"cwd",
	"glob",
	"globs",
	"target",
	"targets",
	"source",
	"destination",
	"dest",
	"from",
	"to",
]);

function isPathInputKey(key: string): boolean {
	return PATH_INPUT_KEYS.has(key.toLowerCase().replace(/[^a-z0-9]/g, ""));
}

export function collectPathInputs(input: Record<string, unknown>): string[] {
	const paths: string[] = [];
	for (const [key, value] of Object.entries(input)) {
		if (['edits', 'changes', 'operations', 'files'].includes(key) && value && typeof value === 'object') {
			for (const item of Array.isArray(value) ? value : Object.values(value)) {
				if (item && typeof item === 'object') paths.push(...collectPathInputs(item as Record<string, unknown>));
			}
		}
		if (!isPathInputKey(key)) continue;
		if (typeof value === "string" && value.trim()) paths.push(value);
		else if (Array.isArray(value)) {
			paths.push(
				...value.filter(
					(item): item is string =>
						typeof item === "string" && item.trim().length > 0,
				),
			);
		}
	}
	return [...new Set(paths)];
}

/** Resolve existing ancestors and dangling symlinks before applying path rules. */
export function canonicalInputPath(input: string, cwd: string, depth = 0): string {
  if (depth > 40) throw new Error('Too many symbolic links in permission target');
  let candidate = resolveInputPath(input, cwd);
  const suffix: string[] = [];
  for (;;) {
    try {
      const info = lstatSync(candidate);
      if (info.isSymbolicLink()) {
        const target = canonicalInputPath(readlinkSync(candidate), path.dirname(candidate), depth + 1);
        return path.join(target, ...suffix);
      }
      return path.join(realpathSync(candidate), ...suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      suffix.unshift(path.basename(candidate));
      candidate = parent;
    }
  }
}
