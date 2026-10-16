import { OrchestrationError } from './errors.js';

// Worker tool profiles (#151, ADR 0014). A profile names what a worker must
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
//
// A profile may also carry `skills` (#226): name patterns of the skills the
// worker's prompt lists. Without it the worker lists every skill, as before.
// The skills of the worker's own project always stay, because its AGENTS.md
// may make them mandatory.

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
 * `skills` (the spawn's choice) wins over `roleSkills` (the role default);
 * with neither the profile has no `skills` and the worker keeps them all.
 */
export const resolveProfile = ({ profile, role, excludeExtensions = [], skills, roleSkills }) => {
  const name = profile ?? ROLE_PROFILES[role] ?? 'full';
  const definition = Object.hasOwn(TOOL_PROFILES, name) ? TOOL_PROFILES[name] : undefined;
  if (!definition) throw new OrchestrationError('INVALID_ARGUMENT', `Unknown profile: ${name}`);
  return {
    name,
    excludeTools: [...definition.excludeTools],
    excludeExtensions: [...new Set([...definition.excludeExtensions, ...excludeExtensions])],
    ...((skills ?? roleSkills) ? { skills: [...new Set(skills ?? roleSkills)] } : {}),
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
  if (!profile || typeof profile.name !== 'string' || !isPatternList(profile.excludeTools) || !isPatternList(profile.excludeExtensions)
    || (profile.skills !== undefined && !isPatternList(profile.skills))) {
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
 * Paths of the extensions a session with this recorded profile loads, from
 * Pi's resolved extension resources (`DefaultPackageManager.resolve()`):
 * the enabled ones that no pattern excludes by path or by package source.
 * An unreadable profile loads none. PiChamber's inline extensions are not
 * resources and always load: they carry orchestration itself.
 */
export const keptExtensionPaths = (resources, profile) => {
  if (profile === null) return [];
  const excluded = patternMatcher(profile.excludeExtensions);
  return resources
    .filter((resource) => resource.enabled && !excluded(resource.path) && !(resource.metadata?.source && excluded(resource.metadata.source)))
    .map((resource) => resource.path);
};

/** Whether a session with this recorded profile lists only some skills. */
export const selectsSkills = (profile) => profile === null || (profile !== undefined && profile.skills !== undefined);

/**
 * The skills a session with this recorded profile lists, from the skills Pi
 * loaded: its project skills (paths Pi resolved with project scope) and those
 * whose name a pattern matches. An unreadable profile keeps project skills only.
 */
export const keptSkills = (skills, profile, projectSkillPaths) => {
  if (!selectsSkills(profile)) return skills;
  const chosen = patternMatcher(profile?.skills ?? []);
  return skills.filter((skill) => projectSkillPaths.has(skill.filePath) || chosen(skill.name));
};
