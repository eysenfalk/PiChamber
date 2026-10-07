import type { ToolRisk } from './types.ts';

export type ToolHints = { readOnlyHint?: boolean; destructiveHint?: boolean };
const READ_ONLY_TOOLS = new Set([
  'read', 'grep', 'find', 'ls', 'ast_search', 'ast_grep_search', 'lsp_diagnostics',
  'lsp_navigation', 'harness_status', 'repo_tree', 'repo_scripts', 'repo_context',
  'git_diff_summary', 'detect_verification_commands', 'validate_skills',
  'validate_prompts', 'markdown_link_check', 'harness_inventory', 'harness_audit',
  'task_state_check', 'permissions_tool_inventory', 'signet_recall',
  'aft_search', 'aft_outline', 'aft_zoom', 'aft_callgraph', 'aft_inspect',
  'aft_safety', 'aft_conflicts', 'url_context', 'web_search', 'openai_websearch',
  'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
]);
const WRITE_TOOLS = new Set([
  'edit', 'write', 'ast_grep_replace', 'modus_workflow', 'aft_import',
  'aft_move', 'aft_delete', 'bash_write', 'bash_kill',
]);
// These hosts delegate each inner call through permission middleware. Their
// programs are not classified by scanning code strings. Separate processes
// and arbitrary unregistered host effects are outside this gate.
const ORCHESTRATORS = new Set(['fabric_exec', 'codemode']);
const leafName = (name: string) => name.startsWith('mcp__') ? name.split('__').slice(2).join('__') : name;

export function isWriteTool(name: string): boolean {
  const leaf = leafName(name);
  return WRITE_TOOLS.has(leaf) || /(^|[-_])(write|edit|patch|replace|delete|remove|move|rename|apply|create|update|import)([-_]|$)/i.test(leaf);
}

export function isReadOnlyTool(name: string, hints?: ToolHints): boolean {
  if (isWriteTool(name) || hints?.destructiveHint === true || hints?.readOnlyHint === false) return false;
  if (hints?.readOnlyHint === true) return true;
  const leaf = leafName(name);
  if (READ_ONLY_TOOLS.has(leaf) || ORCHESTRATORS.has(leaf)) return true;
  // Known read-only wrappers; do not infer safety for arbitrary MCP servers.
  if (/^mcp__(atlassian_onprem|awx)__/.test(name)) return /^(get|list|search|read|fetch|find)_/.test(leaf) || /^(jira|confluence)_(get|search|list)_/.test(leaf);
  return false;
}

export function isReadOnlyBashCommand(command: string): boolean {
  // Conservative lexical checks, not a shell parser or OS sandbox.
  if (/[;&\n\r<>`]|\$\(|\\\n/.test(command) || /\|\|/.test(command)) return false;
  return command.split('|').every((part) => {
    const text = part.trim();
    if (!text || /\b(rm|mv|cp|mkdir|touch|chmod|chown|tee|dd|sudo|kill|ssh|scp|rsync|exec)\b/i.test(text)) return false;
    if (/^git\s+(status|log|diff|show|ls-files|ls-tree)(?:\s|$)/.test(text)) return !/--(output|exec|ext-diff|textconv)\b/.test(text);
    if (/^git\s+branch(?:\s+--show-current|\s+--list(?:\s+\S+)*)?\s*$/.test(text)) return true;
    if (/^git\s+remote(?:\s+-v)?\s*$/.test(text)) return true;
    if (/^git\s+config\s+--get\s+[^\s]+\s*$/.test(text)) return true;
    if (/^(node|python|python3|ruby|perl|php)\s+--version\s*$/.test(text)) return true;
    if (/^(npm|pnpm|yarn)\s+(list|ls|view|info|why|search|outdated|audit)(?:\s|$)/.test(text)) return !/--(fix|global|location)|\s-g\b/.test(text);
    if (/^find(?:\s|$)/.test(text) && /-(exec|execdir|ok|okdir|delete|fprint|fprintf|fls)\b/.test(text)) return false;
    return /^(cat|head|tail|less|more|grep|rg|find|fd|ls|pwd|echo|printf|wc|sort|uniq|diff|file|stat|du|df|tree|which|whereis|uname|whoami|id|date|uptime|ps|free)(?:\s|$)/.test(text)
      && !/--?(o|output|files0-from)(?:=|\s)/.test(text);
  });
}

export function classifyToolRisk(name: string): ToolRisk {
  if (name === 'bash' || name === 'powershell') return 'shell';
  if (isWriteTool(name)) return 'write';
  if (isReadOnlyTool(name)) return 'read-only';
  if (name.startsWith('mcp__') || name === 'mcp') return 'external';
  if (name === 'signet_remember' || name === 'signet_memory_feedback') return 'memory-write';
  return 'unknown';
}
