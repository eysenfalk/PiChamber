import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PermissionConfig, PermissionAction, PermissionCheck, RuleSet, HeuristicPatterns } from './types.ts';
import { strictestAction } from './actions.ts';
import { globMatches, matchRule } from './rules.ts';
import { collectPathInputs, resolveInputPath, canonicalInputPath, displayPath, isOutsideWorkspace, commandPathReferences, commandHasWorkspaceEscape } from './paths.ts';
import { isWriteTool, isReadOnlyTool, isReadOnlyBashCommand, type ToolHints } from './tool-risk.ts';
type ExtensionContext = { cwd: string };

export function createRuleCheck(
	category: PermissionCheck["category"],
	target: string,
	rules: RuleSet,
	defaultAction: PermissionAction,
	reason: string,
	suggestedPattern = target,
	repoRules?: RuleSet,
): PermissionCheck {
	const matched = matchRule(rules, target);
	let action = matched?.action ?? defaultAction;
	let pattern = matched?.pattern ?? "<default>";

	const repoMatch = repoRules ? matchRule(repoRules, target) : undefined;
	if (repoMatch && strictestAction(action, repoMatch.action) !== action) {
		action = repoMatch.action;
		pattern = `repo:${repoMatch.pattern}`;
	}

	return { category, target, action, pattern, suggestedPattern, reason };
}

function createOutsideWorkspaceCheck(
	config: PermissionConfig,
	target: string,
): PermissionCheck {
	const rules = config.permission.outsideWorkspace;
	const repoRules = config.repo?.permission.outsideWorkspace;
	if (typeof rules === "string") {
		const repoMatch = repoRules ? matchRule(repoRules, target) : undefined;
		const action = repoMatch
			? strictestAction(rules, repoMatch.action)
			: rules;
		return {
			category: "outside-workspace",
			target,
			action,
			pattern:
				repoMatch && action !== rules
					? `repo:${repoMatch.pattern}`
					: "<outsideWorkspace>",
			suggestedPattern: target,
			reason: `Outside workspace access: ${target}`,
		};
	}
	return createRuleCheck(
		"outside-workspace",
		target,
		rules,
		"ask",
		`Outside workspace access: ${target}`,
		target,
		repoRules,
	);
}

function heuristicChecks(
	config: PermissionConfig,
	command: string,
): PermissionCheck[] {
	const entries: [string, HeuristicPatterns[string]][] = config.heuristics
		.enabled
		? Object.entries(config.heuristics.patterns)
		: [];
	// Repo heuristics are additive and can only tighten, so they apply even when
	// the global heuristic set is disabled.
	for (const [name, entry] of Object.entries(config.repo?.heuristics ?? {}))
		entries.push([`repo:${name}`, entry]);

	const checks: PermissionCheck[] = [];
	for (const [name, entry] of entries) {
		if (!name.startsWith('repo:') && config.permission.commands[command] === 'allow') continue;
		for (const pattern of entry.patterns) {
			if (!globMatches(pattern, command)) continue;
			checks.push({
				category: "heuristic",
				target: command,
				action: entry.action,
				pattern: `${name}:${pattern}`,
				suggestedPattern: command,
				reason: `Heuristic matched (${name}): ${pattern}`,
			});
			break;
		}
	}
	return checks;
}

export function collectChecks(
	config: PermissionConfig,
	event: { toolName: string; input?: unknown },
	ctx: ExtensionContext,
): PermissionCheck[] {
	const input =
		event.input && typeof event.input === "object"
			? (event.input as Record<string, unknown>)
			: {};
	const cwd = ctx.cwd ?? ".";
	const checks: PermissionCheck[] = [];

	checks.push(
		createRuleCheck(
			"tool",
			event.toolName,
			config.permission.tools,
			"ask",
			`Tool permission: ${event.toolName}`,
			event.toolName,
			config.repo?.permission.tools,
		),
	);
	if (
		event.toolName === "factory_workspace" &&
		(input.action === "create" || input.action === "close")
	) {
		const target = `factory_workspace:${String(input.action)}`;
		checks.push({
			category: "tool",
			target,
			action: "confirm",
			pattern: target,
			suggestedPattern: target,
			reason: `Factory workspace mutation requires confirmation: ${String(input.action)}`,
		});
	}

	if ((event.toolName === 'bash' || event.toolName === 'powershell') && typeof (input.command ?? input.cmd) === 'string') {
		const command = String(input.command ?? input.cmd).trim();
		checks.push(
			createRuleCheck(
				"command",
				command,
				config.permission.commands,
				"ask",
				`Command permission: ${command}`,
				command,
				config.repo?.permission.commands,
			),
		);
		checks.push(...heuristicChecks(config, command));

		for (const rawPath of commandPathReferences(command)) {
			const absPath = resolveInputPath(rawPath, cwd);
			if (isOutsideWorkspace(absPath, cwd))
				checks.push(
					createOutsideWorkspaceCheck(config, displayPath(absPath, cwd)),
				);
		}
		if (commandHasWorkspaceEscape(command)) {
			checks.push(
				createOutsideWorkspaceCheck(config, "<command workspace escape>"),
			);
		}
	}

	const isWrite = isWriteTool(event.toolName);
	const isPathRead = !isWrite;
	const pathInputs = collectPathInputs(input);
	if (event.toolName === "modus_workflow" && input.action === "define") {
		const scope = input.stateScope ?? "session-temp";
		if (scope === "repository") pathInputs.push(path.join(cwd, ".pi", "modus"));
		if (scope === "session-temp") pathInputs.push(tmpdir());
	}
	const targets = new Set(pathInputs.flatMap(rawPath => [resolveInputPath(rawPath, cwd), canonicalInputPath(rawPath, cwd)]));
	for (const absPath of targets) {
		const shown = displayPath(absPath, cwd);
		if (isOutsideWorkspace(absPath, cwd))
			checks.push(createOutsideWorkspaceCheck(config, shown));
		if (isWrite) {
			checks.push(
				createRuleCheck(
					"write-path",
					shown,
					config.permission.paths.write,
					"ask",
					`Write path permission: ${shown}`,
					shown,
					config.repo?.permission.paths.write,
				),
			);
		} else if (isPathRead) {
			checks.push(
				createRuleCheck(
					"read-path",
					shown,
					config.permission.paths.read,
					"allow",
					`Read path permission: ${shown}`,
					shown,
					config.repo?.permission.paths.read,
				),
			);
		}
	}

	return checks;
}
export function collectReadOnlyChecks(
	config: PermissionConfig,
	event: { toolName: string; input?: unknown },
	ctx: ExtensionContext,
): PermissionCheck[] {
	return collectChecks(config, event, ctx).filter(
		(check) =>
			check.category === "read-path" ||
			check.category === "outside-workspace" ||
			check.category === "heuristic",
	);
}

export function readOnlyBlockReason(event: {
	toolName: string;
	input?: unknown;
}, hints?: ToolHints): string | undefined {
	if (event.toolName === "bash") {
		const input =
			event.input && typeof event.input === "object"
				? (event.input as Record<string, unknown>)
				: {};
		const command = typeof (input.command ?? input.cmd) === 'string' ? String(input.command ?? input.cmd) : '';
		if (!isReadOnlyBashCommand(command))
			return `Read-only override blocked bash command: ${command}`;
		return undefined;
	}
	if (event.toolName === "factory_workspace") {
		const input =
			event.input && typeof event.input === "object"
				? (event.input as Record<string, unknown>)
				: {};
		if (input.action === "doctor" || input.action === "validate") return undefined;
		return `Read-only override blocked Factory workspace mutation: ${String(input.action)}`;
	}
	if (isWriteTool(event.toolName))
		return `Read-only override blocked mutating tool: ${event.toolName}`;
	if (!isReadOnlyTool(event.toolName, hints))
		return `Read-only override blocked non-read-only tool: ${event.toolName}`;
	return undefined;
}
