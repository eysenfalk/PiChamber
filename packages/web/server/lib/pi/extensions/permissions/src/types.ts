/** Shared permission contracts. */
export type PermissionAction = "allow" | "ask" | "confirm" | "forbid";
export type PermissionMode = "ask" | "auto" | "yolo";
export type RuleSet = Record<string, PermissionAction>;


export type AskChoice =
	| "Allow once"
	| "Always allow this session"
	| "Always allow globally"
	| "Denied";

export type PermissionCheck = {
	category:
		| "tool"
		| "command"
		| "read-path"
		| "write-path"
		| "outside-workspace"
		| "heuristic";
	target: string;
	action: PermissionAction;
	pattern: string;
	suggestedPattern: string;
	reason: string;
};

export type PermissionConfig = {
	version: 1;
	mode: PermissionMode;
	readOnly: boolean;
	permission: {
		tools: RuleSet;
		commands: RuleSet;
		paths: {
			read: RuleSet;
			write: RuleSet;
		};
		outsideWorkspace: PermissionAction | RuleSet;
	};
	heuristics: {
		enabled: boolean;
		patterns: HeuristicPatterns;
	};
	/** Repository-scoped rules; may only tighten the global config. */
	repo?: RepoRules;
};

export type HeuristicPatterns = Record<
	string,
	{ action: PermissionAction; patterns: string[] }
>;

/**
 * Rules loaded from `<repo>/.pi/permissions.json`.
 *
 * A repo file travels with cloned code and is writable by tools, so it never
 * carries runtime state (`mode`, `readOnly`) and never weakens the global
 * config: every decision takes the strictest of the global and repo match.
 */
export type RepoRules = {
	path: string;
	permission: {
		tools: RuleSet;
		commands: RuleSet;
		paths: { read: RuleSet; write: RuleSet };
		outsideWorkspace: RuleSet;
	};
	heuristics: HeuristicPatterns;
};

export type ToolRisk =
	| "read-only"
	| "write"
	| "shell"
	| "memory-write"
	| "external"
	| "unknown";

export type TruncationStats = {
	enabled: true;
	maxDepth: number;
	maxStringLength: number;
	maxArrayLength: number;
	maxObjectKeys: number;
	truncatedCount: number;
};

export type ToolInventoryRecord = {
	name: string;
	description: string;
	parameters: unknown;
	sourceInfo: unknown;
	active: boolean;
	permission: {
		risk: ToolRisk;
		defaultAction: PermissionAction;
		matchedRule: string;
		readOnlyAllowed: boolean;
	};
};

export type ToolInventory = {
	schemaVersion: 1;
	generatedAt: string;
	fingerprint: string;
	reason: string;
	toolCount: number;
	activeToolCount: number;
	activeTools: string[];
	truncation: TruncationStats;
	tools: ToolInventoryRecord[];
};

export type ToolInventoryRequest = {
	full?: boolean;
	tool?: string;
	includeInactive?: boolean;
};
