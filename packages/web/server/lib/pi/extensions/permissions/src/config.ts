import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { PermissionConfig, PermissionAction, RuleSet, RepoRules, PermissionCheck } from './types.ts';
import { normalizeAction, normalizeRuleSet, normalizeConfiguredRuleSet } from './actions.ts';

export function defaultConfig(): PermissionConfig {
	return {
		version: 1,
		mode: "auto",
		readOnly: false,
		permission: {
			tools: {
				"*": "ask",
				read: "allow",
				grep: "allow",
				find: "allow",
				ls: "allow",
				ast_search: "allow",
				ast_grep_search: "allow",
				lsp_diagnostics: "allow",
				lsp_navigation: "allow",
				harness_status: "allow",
				repo_tree: "allow",
				repo_scripts: "allow",
				repo_context: "allow",
				git_diff_summary: "allow",
				detect_verification_commands: "allow",
				validate_skills: "allow",
				validate_prompts: "allow",
				markdown_link_check: "allow",
				harness_inventory: "allow",
				harness_audit: "allow",
				task_state_check: "allow",
				signet_recall: "allow",
				signet_memory_feedback: "ask",
				signet_remember: "ask",
				permissions_tool_inventory: "allow",
				mcp: "ask",
				bash: "ask",
				nu: "ask",
				edit: "ask",
				write: "ask",
				ast_grep_replace: "ask",
				powershell: "ask",
				"mcp__atlassian_confluence_write__*": "confirm",
				run_verification: "ask",
			},
			commands: {
				"*": "ask",
				"ssh *": "confirm",
				"scp *": "confirm",
				"sftp *": "confirm",
			},
			paths: {
				read: {
					"*": "allow",
					"*.env": "confirm",
					"*.env.*": "confirm",
					"*.pem": "confirm",
					"*.key": "confirm",
					"~/.ssh/**": "confirm",
					"~/.aws/**": "confirm",
				},
				write: {
					"*": "ask",
					"*.env": "confirm",
					"*.env.*": "confirm",
					"*.pem": "confirm",
					"*.key": "confirm",
					".git/**": "confirm",
					"node_modules/**": "confirm",
					"~/.ssh/**": "confirm",
					"~/.aws/**": "confirm",
					"*.pi/permissions.json": "confirm",
					"*extensions/permissions/*": "confirm",
				},
			},
			outsideWorkspace: "ask",
		},
		heuristics: {
			enabled: true,
			patterns: {
				remoteAccess: {
					action: "confirm",
					patterns: ["ssh *", "scp *", "sftp *", "rsync *"],
				},
				inlineInterpreter: {
					action: "ask",
					patterns: [
						"*python -c*",
						"*python3 -c*",
						"*node -e*",
						"*ruby -e*",
						"*perl -e*",
						"*php -r*",
					],
				},
				subprocess: {
					action: "ask",
					patterns: [
						"*subprocess*",
						"*child_process*",
						"*execSync*",
						"*spawn*",
					],
				},
				shellWrite: {
					action: "ask",
					patterns: ["*>*", "*>>*", "* tee *", "*<<*"],
				},
				secretRead: {
					action: "ask",
					patterns: ["*.env*", "*.pem*", "*.key*", "*.ssh*", "*.aws*"],
				},
			},
		},
	};
}

export function createConfigStore(agentDir: string) {
const CONFIG_PATH = path.join(agentDir, 'permissions.json');
const REPO_CONFIG_RELATIVE = path.join('.pi', 'permissions.json');

function loadConfig(cwd?: string): PermissionConfig {
	const repo = cwd ? loadRepoRules(cwd) : undefined;
	const base = defaultConfig();
	if (!existsSync(CONFIG_PATH)) return { ...base, repo };

	try {
		const raw = readPermissionObject(CONFIG_PATH) as Partial<PermissionConfig>;
		const permission = (raw.permission ?? {}) as Partial<
			PermissionConfig["permission"]
		>;
		const paths = (permission.paths ?? {}) as Partial<
			PermissionConfig["permission"]["paths"]
		>;
		const heuristics = (raw.heuristics ?? {}) as Partial<
			PermissionConfig["heuristics"]
		>;
		const heuristicPatterns =
			heuristics.patterns && typeof heuristics.patterns === "object"
				? heuristics.patterns
				: {};

		return {
			version: 1,
			mode:
				raw.mode === "auto" || raw.mode === "yolo" || raw.mode === "ask"
					? raw.mode
					: base.mode,
			readOnly:
				typeof raw.readOnly === "boolean" ? raw.readOnly : base.readOnly,
			permission: {
				tools: normalizeRuleSet(permission.tools, base.permission.tools),
				commands: normalizeConfiguredRuleSet(
					permission.commands,
					base.permission.commands,
				),
				paths: {
					read: normalizeRuleSet(paths.read, base.permission.paths.read),
					write: normalizeRuleSet(paths.write, base.permission.paths.write),
				},
				outsideWorkspace: normalizeOutsideWorkspace(
					permission.outsideWorkspace,
					base.permission.outsideWorkspace,
				),
			},
			heuristics: {
				enabled:
					typeof heuristics.enabled === "boolean"
						? heuristics.enabled
						: base.heuristics.enabled,
				patterns: {
					...base.heuristics.patterns,
					...normalizeHeuristicPatterns(heuristicPatterns),
				},
			},
			repo,
		};
	} catch (error) {
		throw new Error(`Invalid permissions config ${CONFIG_PATH}: ${error instanceof Error ? error.message : error}`);
	}
}

/**
 * Find the nearest `<dir>/.pi/permissions.json` at or above `cwd`, stopping at
 * the enclosing repository root. The global config is never treated as a repo
 * config.
 */
function findRepoConfigPath(cwd: string): string | undefined {
	let dir = path.resolve(cwd);
	for (;;) {
		const candidate = path.join(dir, REPO_CONFIG_RELATIVE);
		if (candidate !== CONFIG_PATH && existsSync(candidate)) return candidate;
		if (existsSync(path.join(dir, ".git"))) return undefined;
		const parent = path.dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/**
 * Load repository-scoped rules. `mode`, `readOnly`, and `heuristics.enabled`
 * are ignored on purpose: a repo file may only tighten, never relax.
 */
function loadRepoRules(cwd: string): RepoRules | undefined {
	const repoPath = findRepoConfigPath(cwd);
	if (!repoPath) return undefined;

	try {
		const raw = readPermissionObject(repoPath, true);
		const permission = (raw.permission ?? {}) as Record<string, unknown>;
		const paths = (permission.paths ?? {}) as Record<string, unknown>;
		const heuristics = (raw.heuristics ?? {}) as Record<string, unknown>;
		return {
			path: repoPath,
			permission: {
				tools: normalizeConfiguredRuleSet(permission.tools, {}),
				commands: normalizeConfiguredRuleSet(permission.commands, {}),
				paths: {
					read: normalizeConfiguredRuleSet(paths.read, {}),
					write: normalizeConfiguredRuleSet(paths.write, {}),
				},
				outsideWorkspace: normalizeConfiguredRuleSet(
					permission.outsideWorkspace,
					{},
				),
			},
			heuristics: normalizeHeuristicPatterns(heuristics.patterns),
		};
	} catch (error) {
		throw new Error(`Invalid repository permissions config ${repoPath}: ${error instanceof Error ? error.message : error}`);
	}
}

function normalizeOutsideWorkspace(
	value: unknown,
	fallback: PermissionAction | RuleSet,
): PermissionAction | RuleSet {
	const action = normalizeAction(value);
	if (action) return action;
	if (value && typeof value === "object" && !Array.isArray(value))
		return normalizeRuleSet(
			value,
			typeof fallback === "string" ? {} : fallback,
		);
	return fallback;
}

function normalizeHeuristicPatterns(
	value: unknown,
): PermissionConfig["heuristics"]["patterns"] {
	const result: PermissionConfig["heuristics"]["patterns"] = {};
	if (!value || typeof value !== "object" || Array.isArray(value))
		return result;

	for (const [name, entry] of Object.entries(
		value as Record<string, unknown>,
	)) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const object = entry as { action?: unknown; patterns?: unknown };
		const action = normalizeAction(object.action);
		if (!action || !Array.isArray(object.patterns)) continue;
		const patterns = object.patterns.filter(
			(pattern): pattern is string =>
				typeof pattern === "string" && pattern.length > 0,
		);
		if (patterns.length > 0) result[name] = { action, patterns };
	}

	return result;
}

function loadConfigForWrite(): Record<string, unknown> {
	if (!existsSync(CONFIG_PATH)) {
		return { ...defaultConfig(), $comment: 'Native Pi permissions. Last matching rule wins. Yolo bypasses every custom check.' };
	}

	try {
		return readPermissionObject(CONFIG_PATH);
	} catch (error) {
		throw new Error(`Cannot update invalid permissions config: ${error instanceof Error ? error.message : error}`);
	}
}

function ensureObject(
	parent: Record<string, unknown>,
	key: string,
): Record<string, unknown> {
	if (
		!parent[key] ||
		typeof parent[key] !== "object" ||
		Array.isArray(parent[key])
	)
		parent[key] = {};
	return parent[key] as Record<string, unknown>;
}

function saveConfigObject(config: Record<string, unknown>): void {
	mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
	const tempPath = `${CONFIG_PATH}.${process.pid}.tmp`;
	writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
	renameSync(tempPath, CONFIG_PATH);
}

function addGlobalAllow(checks: PermissionCheck[]): void {
	const persisted = loadConfigForWrite();
	const permission = ensureObject(persisted, "permission");
	const tools = ensureObject(permission, "tools");
	const commands = ensureObject(permission, "commands");
	const paths = ensureObject(permission, "paths");
	const readPaths = ensureObject(paths, "read");
	const writePaths = ensureObject(paths, "write");
	let outsideWorkspace = permission.outsideWorkspace;
	if (
		!outsideWorkspace ||
		typeof outsideWorkspace !== "object" ||
		Array.isArray(outsideWorkspace)
	) {
		outsideWorkspace = typeof outsideWorkspace === 'string' ? { '*': outsideWorkspace } : {};
		permission.outsideWorkspace = outsideWorkspace;
	}

	for (const check of checks) {
		switch (check.category) {
			case "tool":
				tools[check.suggestedPattern] = "allow";
				break;
			case "command":
			case "heuristic":
				commands[check.suggestedPattern] = "allow";
				break;
			case "read-path":
				readPaths[check.suggestedPattern] = "allow";
				break;
			case "write-path":
				writePaths[check.suggestedPattern] = "allow";
				break;
			case "outside-workspace":
				(outsideWorkspace as Record<string, unknown>)[check.suggestedPattern] =
					"allow";
				break;
		}
	}

	saveConfigObject(persisted);
}

return { path: CONFIG_PATH, load: loadConfig, allowGlobally: addGlobalAllow, save: saveConfigObject };
}


function readPermissionObject(file: string, repo = false): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const object = (value: unknown) => !!value && typeof value === 'object' && !Array.isArray(value);
  if (!object(raw) || (raw.version !== undefined && raw.version !== 1)) throw new Error('Unsupported permissions object/version');
  if (!repo && raw.mode !== undefined && !['ask', 'auto', 'yolo'].includes(raw.mode)) throw new Error('Invalid permission mode');
  if (!repo && raw.readOnly !== undefined && typeof raw.readOnly !== 'boolean') throw new Error('Invalid readOnly setting');
  for (const key of ['permission', 'heuristics']) if (raw[key] !== undefined && !object(raw[key])) throw new Error(`Invalid ${key} object`);
  if (raw.permission?.paths !== undefined && !object(raw.permission.paths)) throw new Error('Invalid paths object');
  if (raw.heuristics?.enabled !== undefined && typeof raw.heuristics.enabled !== 'boolean') throw new Error('Invalid heuristics.enabled');
  if (raw.heuristics?.patterns !== undefined) {
    if (!object(raw.heuristics.patterns)) throw new Error('Invalid heuristic patterns');
    for (const [name, entry] of Object.entries(raw.heuristics.patterns)) {
      const value = entry as {action?: unknown; patterns?: unknown};
      if (!object(value) || !normalizeAction(value.action) || !Array.isArray(value.patterns) || value.patterns.some(pattern => typeof pattern !== 'string')) throw new Error(`Invalid heuristic ${name}`);
    }
  }
  return raw;
}
