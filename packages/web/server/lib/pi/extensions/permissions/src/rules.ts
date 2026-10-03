import path from 'node:path';
import type { PermissionAction, RuleSet } from './types.ts';

function escapeRegex(value: string): string {
	return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

export function globMatches(pattern: string, target: string): boolean {
	const normalizedPattern = pattern.split(path.sep).join("/");
	const normalizedTarget = target.split(path.sep).join("/");
	const regexBody = normalizedPattern.split("*").map(escapeRegex).join(".*");
	const regex = new RegExp(`^${regexBody}$`, "i");
	return regex.test(normalizedTarget);
}

export function matchRule(
	rules: RuleSet,
	target: string,
): { action: PermissionAction; pattern: string } | undefined {
	let matched: { action: PermissionAction; pattern: string } | undefined;
	for (const [pattern, action] of Object.entries(rules)) {
		if (globMatches(pattern, target)) matched = { action, pattern };
	}
	return matched;
}

