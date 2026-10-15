/**
 * Port of Pi's slash autocomplete matching, so PiChamber's command palette
 * finds and orders commands the way Pi's TUI does. Source:
 * @earendil-works/pi-tui 1.1.0, dist/fuzzy.js (`fuzzyMatch`, `fuzzyFilter`).
 * pi-tui is not a dependency of this package, so the two functions are kept
 * here unchanged in behavior. Lower score is a better match.
 */

export interface PiFuzzyMatch {
  matches: boolean;
  score: number;
}

export function piFuzzyMatch(query: string, text: string): PiFuzzyMatch {
  const queryLower = query.toLowerCase();
  const textLower = text.toLowerCase();

  const matchQuery = (normalizedQuery: string): PiFuzzyMatch => {
    if (normalizedQuery.length === 0) return { matches: true, score: 0 };
    if (normalizedQuery.length > textLower.length) return { matches: false, score: 0 };

    let queryIndex = 0;
    let score = 0;
    let lastMatchIndex = -1;
    let consecutiveMatches = 0;

    while (queryIndex < normalizedQuery.length) {
      const i = textLower.indexOf(normalizedQuery[queryIndex], lastMatchIndex + 1);
      if (i === -1) break;

      const isWordBoundary = i === 0 || /[\s\-_./:]/.test(textLower[i - 1]);
      if (lastMatchIndex === i - 1) {
        consecutiveMatches++;
        score -= consecutiveMatches * 5;
      } else {
        consecutiveMatches = 0;
        if (lastMatchIndex >= 0) score += (i - lastMatchIndex - 1) * 2;
      }
      if (isWordBoundary) score -= 10;
      score += i * 0.1;
      lastMatchIndex = i;
      queryIndex++;
    }

    if (queryIndex < normalizedQuery.length) return { matches: false, score: 0 };
    if (normalizedQuery === textLower) score -= 100;
    return { matches: true, score };
  };

  const primaryMatch = matchQuery(queryLower);
  if (primaryMatch.matches) return primaryMatch;

  const alphaNumericMatch = queryLower.match(/^(?<letters>[a-z]+)(?<digits>[0-9]+)$/);
  const numericAlphaMatch = queryLower.match(/^(?<digits>[0-9]+)(?<letters>[a-z]+)$/);
  const swappedQuery = alphaNumericMatch
    ? `${alphaNumericMatch.groups?.digits ?? ""}${alphaNumericMatch.groups?.letters ?? ""}`
    : numericAlphaMatch
      ? `${numericAlphaMatch.groups?.letters ?? ""}${numericAlphaMatch.groups?.digits ?? ""}`
      : "";
  if (!swappedQuery) return primaryMatch;

  const swappedMatch = matchQuery(swappedQuery);
  if (!swappedMatch.matches) return primaryMatch;
  return { matches: true, score: swappedMatch.score + 5 };
}

/**
 * Best match first. Whitespace- and slash-separated tokens must all match.
 * The sort is stable, so equal scores keep the input order.
 */
export function piFuzzyFilter<T>(items: readonly T[], query: string, getText: (item: T) => string): T[] {
  if (!query.trim()) return [...items];
  const tokens = query.trim().split(/[\s/]+/).filter((token) => token.length > 0);
  if (tokens.length === 0) return [...items];

  const results: { item: T; totalScore: number }[] = [];
  for (const item of items) {
    const text = getText(item);
    let totalScore = 0;
    let allMatch = true;
    for (const token of tokens) {
      const match = piFuzzyMatch(token, text);
      if (!match.matches) {
        allMatch = false;
        break;
      }
      totalScore += match.score;
    }
    if (allMatch) results.push({ item, totalScore });
  }
  results.sort((a, b) => a.totalScore - b.totalScore);
  return results.map((result) => result.item);
}
