import type { PermissionAction, PermissionMode, PermissionCheck, RuleSet } from './types.ts';

const ACTION_ORDER: PermissionAction[] = ["allow", "ask", "confirm", "forbid"];
const ACTION_ALIASES: Record<string, PermissionAction> = {
	allow: "allow",
	allowed: "allow",
	ask: "ask",
	prompt: "ask",
	confirm: "confirm",
	deny: "confirm",
	denied: "confirm",
	forbid: "forbid",
	forbidden: "forbid",
};

function actionRank(action: PermissionAction): number {
	return ACTION_ORDER.indexOf(action);
}

export function strictestAction(
	a: PermissionAction,
	b: PermissionAction,
): PermissionAction {
	return actionRank(b) > actionRank(a) ? b : a;
}

function isAction(value: unknown): value is PermissionAction {
	return (
		typeof value === "string" &&
		ACTION_ORDER.includes(value as PermissionAction)
	);
}

export function normalizeAction(value: unknown): PermissionAction | undefined {
	if (isAction(value)) return value;
	if (typeof value !== "string") return undefined;
	return ACTION_ALIASES[value.trim().toLowerCase()];
}

export function normalizeRuleSet(value: unknown, fallback: RuleSet): RuleSet {
	if (value === undefined) return { ...fallback };
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error('Permission rules must be objects');
	const rules: RuleSet = {};
	for (const [pattern, action] of Object.entries(
		value as Record<string, unknown>,
	)) {
		const normalized = normalizeAction(action);
		if (!normalized) throw new Error(`Invalid permission action for ${pattern}`);
		rules[pattern] = normalized;
	}
	return { ...fallback, ...rules };
}

export function normalizeConfiguredRuleSet(
	value: unknown,
	fallback: RuleSet,
): RuleSet {
	if (value === undefined) return { ...fallback };
	return normalizeRuleSet(value, {});
}

export function modeResolve(
	mode: PermissionMode,
	action: PermissionAction,
): "allow" | "ask" | "block" {
	if (mode === "yolo") return "allow";
	if (action === "forbid") return "block";
	if (action === "allow") return "allow";
	if (mode === "auto") return action === "confirm" ? "ask" : "allow";
	return "ask";
}

export function sessionKey(
	check: Pick<PermissionCheck, "category" | "suggestedPattern">,
): string {
	return JSON.stringify([check.category, check.suggestedPattern]);
}

export function applySessionAllows(
	check: PermissionCheck,
	sessionAllows: Set<string>,
): PermissionCheck {
	if (check.action === "forbid") return check;
	if (sessionAllows.has(sessionKey(check)))
		return { ...check, action: "allow", pattern: check.suggestedPattern };
	return check;
}
