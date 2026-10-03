import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { PermissionConfig, ToolInventory, ToolInventoryRecord, ToolInventoryRequest, TruncationStats } from './types.ts';
import { createRuleCheck } from './checks.ts';
import { classifyToolRisk, isReadOnlyTool } from './tool-risk.ts';

const INVENTORY_ENTRY_TYPE = "permissions-tool-inventory";
const INVENTORY_SCHEMA_VERSION = 1 as const;
const TRUNCATION_LIMITS = {
	maxDepth: 8,
	maxStringLength: 12_000,
	maxArrayLength: 200,
	maxObjectKeys: 200,
};

function safeClone(value: unknown, stats: TruncationStats): unknown {
	const seen = new WeakSet<object>();

	function visit(input: unknown, depth: number): unknown {
		if (typeof input === "function") return "[Function omitted]";
		if (typeof input === "string") {
			if (input.length <= stats.maxStringLength) return input;
			stats.truncatedCount += 1;
			return `${input.slice(0, stats.maxStringLength)}...[truncated ${input.length - stats.maxStringLength} chars]`;
		}
		if (!input || typeof input !== "object") return input;
		if (seen.has(input)) {
			stats.truncatedCount += 1;
			return "[Circular]";
		}
		if (depth >= stats.maxDepth) {
			stats.truncatedCount += 1;
			return "[Truncated: max depth]";
		}

		seen.add(input);
		if (Array.isArray(input)) {
			const items = input
				.slice(0, stats.maxArrayLength)
				.map((item) => visit(item, depth + 1));
			if (input.length > stats.maxArrayLength) {
				stats.truncatedCount += 1;
				items.push(
					`[Truncated ${input.length - stats.maxArrayLength} array items]`,
				);
			}
			return items;
		}

		const entries = Object.entries(input as Record<string, unknown>);
		const output: Record<string, unknown> = {};
		for (const [key, item] of entries.slice(0, stats.maxObjectKeys)) {
			output[key] = visit(item, depth + 1);
		}
		if (entries.length > stats.maxObjectKeys) {
			stats.truncatedCount += 1;
			output.__truncatedKeys = entries.length - stats.maxObjectKeys;
		}
		return output;
	}

	return visit(value, 0);
}

export function summarizeInventory(inventory: ToolInventory, includeInactive = false) {
	const tools = includeInactive
		? inventory.tools
		: inventory.tools.filter((tool) => tool.active);
	const byRisk = tools.reduce<Record<string, string[]>>((acc, tool) => {
		(acc[tool.permission.risk] ??= []).push(tool.name);
		return acc;
	}, {});

	return {
		schemaVersion: inventory.schemaVersion,
		generatedAt: inventory.generatedAt,
		fingerprint: inventory.fingerprint,
		reason: inventory.reason,
		toolCount: inventory.toolCount,
		activeToolCount: inventory.activeToolCount,
		shownToolCount: tools.length,
		truncatedCount: inventory.truncation.truncatedCount,
		byRisk,
	};
}

function stableFingerprint(value: unknown): string {
	const input = JSON.stringify(value);
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i += 1) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}


  export function createInventory(pi: ExtensionAPI, getConfig: () => PermissionConfig) {
function getActiveToolNames(): string[] {
		const tools =
			typeof (pi as any).getActiveTools === "function"
				? (pi as any).getActiveTools()
				: [];
		return (Array.isArray(tools) ? tools : [])
			.map((tool) => (typeof tool === "string" ? tool : tool?.name))
			.filter(
				(name): name is string => typeof name === "string" && name.length > 0,
			);
	}

	function getLatestSessionInventory(
		ctx: ExtensionContext,
	): ToolInventory | undefined {
		const branch = (ctx.sessionManager as any)?.getBranch?.();
		if (!Array.isArray(branch)) return undefined;
		for (let i = branch.length - 1; i >= 0; i -= 1) {
			const entry = branch[i];
			if (
				entry?.type === "custom" &&
				entry?.customType === INVENTORY_ENTRY_TYPE
			) {
				return entry.data as ToolInventory;
			}
		}
		return undefined;
	}

	function buildToolInventory(reason: string): ToolInventory {
const config = getConfig();
		const allTools = Array.isArray((pi as any).getAllTools?.())
			? (pi as any).getAllTools()
			: [];
		const activeTools = getActiveToolNames().sort();
		const activeSet = new Set(activeTools);
		const stats: TruncationStats = {
			enabled: true,
			maxDepth: TRUNCATION_LIMITS.maxDepth,
			maxStringLength: TRUNCATION_LIMITS.maxStringLength,
			maxArrayLength: TRUNCATION_LIMITS.maxArrayLength,
			maxObjectKeys: TRUNCATION_LIMITS.maxObjectKeys,
			truncatedCount: 0,
		};

		const tools = allTools
			.map((tool: any): ToolInventoryRecord => {
				const name = String(tool?.name ?? "");
				const matched = createRuleCheck(
					"tool",
					name,
					config.permission.tools,
					"ask",
					`Tool permission: ${name}`,
					name,
					config.repo?.permission.tools,
				);
				return {
					name,
					description: String(tool?.description ?? ""),
					parameters: safeClone(tool?.parameters, stats),
					sourceInfo: safeClone(tool?.sourceInfo, stats),
					active: activeSet.has(name),
					permission: {
						risk: classifyToolRisk(name),
						defaultAction: matched.action,
						matchedRule: matched.pattern,
						readOnlyAllowed: isReadOnlyTool(name, tool?.annotations),
					},
				};
			})
			.filter((tool: ToolInventoryRecord) => tool.name.length > 0)
			.sort((a: ToolInventoryRecord, b: ToolInventoryRecord) =>
				a.name.localeCompare(b.name),
			);

		const fingerprint = stableFingerprint({
			activeTools,
			tools: tools.map((tool: ToolInventoryRecord) => ({
				name: tool.name,
				active: tool.active,
				risk: tool.permission.risk,
				defaultAction: tool.permission.defaultAction,
				sourceInfo: tool.sourceInfo,
			})),
		});

		return {
			schemaVersion: INVENTORY_SCHEMA_VERSION,
			generatedAt: new Date().toISOString(),
			fingerprint,
			reason,
			toolCount: tools.length,
			activeToolCount: activeTools.length,
			activeTools,
			truncation: stats,
			tools,
		};
	}

	function refreshToolInventory(
		ctx: ExtensionContext,
		reason: string,
		force = false,
	): ToolInventory {
		const next = buildToolInventory(reason);
		const previous = getLatestSessionInventory(ctx);
		if (force || previous?.fingerprint !== next.fingerprint) {
			pi.appendEntry<ToolInventory>(INVENTORY_ENTRY_TYPE, next);
			return next;
		}
		return previous;
	}

	function formatInventorySummary(inventory: ToolInventory): string {
		const summary = summarizeInventory(inventory, true);
		const risks = Object.entries(summary.byRisk)
			.map(([risk, names]) => `${risk}: ${names.length}`)
			.join(", ");
		return [
			`Tools: ${summary.toolCount} registered, ${summary.activeToolCount} active`,
			`Fingerprint: ${summary.fingerprint.slice(0, 12)}`,
			`Generated: ${summary.generatedAt}`,
			`Reason: ${summary.reason}`,
			`Truncations: ${summary.truncatedCount}`,
			`Risks: ${risks || "none"}`,
		].join("\n");
	}

	function selectInventoryPayload(
		inventory: ToolInventory,
		params: ToolInventoryRequest,
	) {
		if (params.tool) {
			const tool = inventory.tools.find(
				(candidate) => candidate.name === params.tool,
			);
			return tool
				? { ...summarizeInventory(inventory, true), tool }
				: {
						...summarizeInventory(inventory, true),
						error: `Tool not found: ${params.tool}`,
					};
		}
		if (params.full) return inventory;
		return summarizeInventory(inventory, Boolean(params.includeInactive));
	}

return { refresh: refreshToolInventory, format: formatInventorySummary, select: selectInventoryPayload };
}

