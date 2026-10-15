import { OrchestrationError } from './errors.js';

// Worker tool profiles (#151, ADR 0013). A profile names what a worker must
// not use: tools by name pattern, extensions by path or package source. The
// resolved profile is fixed at the start and recorded in the worker's lineage
// entry, which stays the authority after a restart; code defaults that change
// later do not touch an existing worker.
//
// `read-only` is a tool limit, not a sandbox: `bash` stays allowed, and through
// the shell a worker can still write. Patterns use `*` like Pi's `--tools`.
// Names cover Pi's built-in tools and the writing tools of the owner's
// installed packages (AFT, pi-subagents), with and without the `mcp__<server>__`
// prefix their MCP proxies carry.

export const TOOL_PROFILES = Object.freeze({
  full: Object.freeze({ excludeTools: Object.freeze([]), excludeExtensions: Object.freeze([]) }),
  'read-only': Object.freeze({
    excludeTools: Object.freeze([
      'edit',
      'write',
      '*aft_delete',
      '*aft_move',
      '*aft_import',
      '*aft_safety',
      '*ast_grep_replace',
      // pi-subagents starts child Pi processes with the full tool set.
      '*subagent*',
    ]),
    excludeExtensions: Object.freeze([]),
  }),
});

export const TOOL_PROFILE_NAMES = Object.freeze(Object.keys(TOOL_PROFILES));

// Roles without an entry run `full`; research keeps it to start subagents.
export const ROLE_PROFILES = Object.freeze({ review: 'read-only', oracle: 'read-only' });

// What a worker keeps when its recorded profile cannot be read: reading,
// nothing that changes files or starts processes. Its final reply still
// reaches the orchestrator.
const FAIL_CLOSED_TOOLS = new Set(['read', 'grep', 'find', 'ls']);

const patternMatcher = (patterns) => {
  const expressions = patterns.map((pattern) => new RegExp(
    `^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`,
  ));
  return (value) => expressions.some((expression) => expression.test(value));
};

/**
 * The profile a start runs with: the requested one, else the role default,
 * else `full`. `excludeExtensions` adds patterns to the profile's own.
 */
export const resolveProfile = ({ profile, role, excludeExtensions = [] }) => {
  const name = profile ?? ROLE_PROFILES[role] ?? 'full';
  const definition = Object.hasOwn(TOOL_PROFILES, name) ? TOOL_PROFILES[name] : undefined;
  if (!definition) throw new OrchestrationError('INVALID_ARGUMENT', `Unknown profile: ${name}`);
  return {
    name,
    excludeTools: [...definition.excludeTools],
    excludeExtensions: [...new Set([...definition.excludeExtensions, ...excludeExtensions])],
  };
};

const isPatternList = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');

/**
 * A worker's recorded profile from its lineage data: undefined for a session
 * without lineage or a worker started before profiles existed (it runs
 * unrestricted, as before), null for a record that cannot be read.
 */
export const recordedProfile = (lineage) => {
  if (!lineage || lineage.profile === undefined) return undefined;
  const { profile } = lineage;
  if (!profile || typeof profile.name !== 'string' || !isPatternList(profile.excludeTools) || !isPatternList(profile.excludeExtensions)) {
    return null;
  }
  return profile;
};

/** Whether a session with this recorded profile may run `toolName`. */
export const toolAllowed = (profile, toolName) => {
  if (profile === undefined) return true;
  if (profile === null) return FAIL_CLOSED_TOOLS.has(toolName);
  return !patternMatcher(profile.excludeTools)(toolName);
};

/**
 * Pi's loaded extensions without the excluded ones. PiChamber's inline
 * extensions (`<inline:...>`) always stay: they carry orchestration itself.
 * An unreadable profile keeps only those.
 */
export const withoutExcludedExtensions = (loaded, profile) => {
  if (profile === undefined) return loaded;
  const excluded = profile === null ? () => true : patternMatcher(profile.excludeExtensions);
  return {
    ...loaded,
    extensions: loaded.extensions.filter((extension) => extension.path.startsWith('<inline:')
      || !(excluded(extension.path) || (extension.sourceInfo?.source && excluded(extension.sourceInfo.source)))),
  };
};
