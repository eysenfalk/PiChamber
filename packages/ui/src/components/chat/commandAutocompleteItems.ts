import { piFuzzyFilter } from "@/lib/search/piFuzzy";

export type CommandAutocompleteCategory =
  "all" | "system" | "skills" | "extensions" | "prompts";

export interface CommandAutocompleteSearchItem {
  name: string;
  /** Executable invocation without the leading `/` (for example `review`,
   * `skill:code-review`, or a Pi-generated extension `hello:2`). When absent,
   * `name` is the invocation. Callers must not reconstruct skill syntax from
   * flags; the catalog owns the executable form. */
  invocationName?: string;
  description?: string;
  searchAliases?: string[];
  source?: "pichamber" | "system" | "pi" | "skill" | "extension" | "prompt";
  isBuiltIn?: boolean;
  isSkill?: boolean;
}

export const commandInvocationName = (item: Pick<CommandAutocompleteSearchItem, "name" | "invocationName">): string =>
  item.invocationName ?? item.name;

function addSearchAliases<T extends CommandAutocompleteSearchItem>(
  winner: T,
  duplicate: T,
): T {
  const winnerInvocation = commandInvocationName(winner);
  const duplicateInvocation = commandInvocationName(duplicate);
  const existingAliases = winner.searchAliases ?? [];
  const aliases = [
    ...existingAliases,
    // Only preserve a loser's bare name as an alias when it differs from the
    // winner's executable invocation; identical `/review` rows must not
    // misrepresent what Pi will execute.
    ...(winnerInvocation === duplicateInvocation && winner.name === duplicate.name ? [] : [duplicate.name]),
    ...(duplicate.invocationName && duplicate.invocationName !== duplicate.name && duplicate.invocationName !== winnerInvocation
      ? [duplicate.invocationName]
      : []),
    ...(duplicate.description ? [duplicate.description] : []),
    ...(duplicate.searchAliases ?? []),
  ].filter(
    (alias, index, values) =>
      alias !== winner.description && values.indexOf(alias) === index,
  );
  const unchanged =
    aliases.length === existingAliases.length &&
    aliases.every((alias, index) => alias === existingAliases[index]);

  return unchanged ? winner : { ...winner, searchAliases: aliases };
}

/**
 * PiChamber-local commands win first, then extension commands, discovered
 * skills, Pi skill commands and prompt templates, then custom commands.
 * Identity is the executable invocation (`review` vs `skill:review`), matching
 * Pi SDK 0.84.1 `getCommands()` and `session.prompt()` resolution where
 * extension commands run before skill/prompt expansion. PiChamber-local
 * system names intercept before Pi.
 */
export function mergeCommandAutocompleteItems<
  T extends CommandAutocompleteSearchItem,
>(builtIns: T[], commands: T[], skills: T[], prompts: T[] = []): T[] {
  const merged: T[] = [];
  const byInvocation = new Map<
    string,
    { index: number; item: T; precedence: number }
  >();

  const addItems = (items: T[], getPrecedence: (item: T) => number) => {
    for (const item of items) {
      const precedence = getPrecedence(item);
      // `/review` and `/skill:review` are different commands and must not
      // collide; a prompt and extension both named `/review` share an
      // invocation and collide with the extension winning (Pi executes
      // extension commands before prompt-template expansion).
      const identity = commandInvocationName(item);
      const existing = byInvocation.get(identity);
      if (!existing) {
        byInvocation.set(identity, { index: merged.length, item, precedence });
        merged.push(item);
        continue;
      }

      const winner =
        precedence > existing.precedence
          ? addSearchAliases(item, existing.item)
          : addSearchAliases(existing.item, item);
      merged[existing.index] = winner;
      byInvocation.set(identity, {
        index: existing.index,
        item: winner,
        precedence: Math.max(existing.precedence, precedence),
      });
    }
  };

  addItems(builtIns, () => 4);
  addItems(commands, (item) =>
    item.isBuiltIn ? 4 : item.source === "extension" ? 3 : item.isSkill ? 1 : 0,
  );
  addItems(skills, () => 2);
  addItems(prompts, () => 1);
  return merged;
}

export function commandMatchesCategory(
  command: CommandAutocompleteSearchItem,
  category: CommandAutocompleteCategory,
): boolean {
  switch (category) {
    case "all":
      return true;
    case "system":
      return Boolean(command.isBuiltIn) || command.source === "pichamber" || command.source === "system";
    case "skills":
      return Boolean(command.isSkill) || command.source === "skill";
    case "extensions":
      return command.source === "extension";
    case "prompts":
      return command.source === "prompt";
  }
}

const SKILL_PREFIX = "skill:";

const isWordChar = (char: string | undefined) => char !== undefined && /[\p{L}\p{N}]/u.test(char);

/** True when `token` starts a word in `text` (case-insensitive). */
function startsAWord(text: string, token: string): boolean {
  const haystack = text.toLowerCase();
  const needle = token.toLowerCase();
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    if (!isWordChar(haystack[at - 1])) return true;
  }
  return false;
}

/**
 * Description or alias match: every whitespace- or slash-separated query token
 * starts a word in the same text. No fuzzy matching, so a long description
 * cannot match on scattered letters.
 */
function commandMetadataMatches(command: CommandAutocompleteSearchItem, query: string): boolean {
  const tokens = query.split(/[\s/]+/).filter((token) => token.length > 0);
  if (tokens.length === 0) return false;
  const texts = [command.description, ...(command.searchAliases ?? [])];
  return texts.some((text) => Boolean(text) && tokens.every((token) => startsAWord(text as string, token)));
}

/**
 * Filter a merged catalog by category and free-text query. The name matches
 * and their order are Pi's slash autocomplete (pi-tui
 * `CombinedAutocompleteProvider`): ranked by `piFuzzyFilter`, a `skill:`
 * command by its bare name first, then those that match only their full name
 * (for example `skill:pro`). Commands that do not match by name but whose
 * description or search alias contains the query as the start of a word come
 * last (a PiChamber extension, Pi has none), in catalog order; scattered
 * letters do not match there. Pure so the desktop rich list and the mobile
 * compact list share one per-keystroke path; the mobile list always
 * passes `all` to keep the full catalog without category chrome.
 */
export function filterAndSortCommands<T extends CommandAutocompleteSearchItem>(
  commands: readonly T[],
  query: string,
  category: CommandAutocompleteCategory,
): T[] {
  const inCategory = commands.filter((command) => commandMatchesCategory(command, category));
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return inCategory;

  const bareName = (command: T) => {
    const invocation = commandInvocationName(command);
    return invocation.startsWith(SKILL_PREFIX) ? invocation.slice(SKILL_PREFIX.length) : invocation;
  };
  const bareNameMatches = piFuzzyFilter(inCategory, normalizedQuery, bareName);
  const bareNameMatchSet = new Set(bareNameMatches);
  const fullNameOnlyMatches = piFuzzyFilter(
    inCategory.filter(
      (command) => commandInvocationName(command).startsWith(SKILL_PREFIX) && !bareNameMatchSet.has(command),
    ),
    normalizedQuery,
    commandInvocationName,
  );
  const nameMatches = [...bareNameMatches, ...fullNameOnlyMatches];
  const nameMatchSet = new Set(nameMatches);
  const metadataMatches = inCategory.filter(
    (command) => !nameMatchSet.has(command) && commandMetadataMatches(command, normalizedQuery),
  );
  return [...nameMatches, ...metadataMatches];
}
