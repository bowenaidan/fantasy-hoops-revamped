// Team-name matching between sources that spell schools differently: the NCAA scoreboard
// ("Iowa St.", "Southern California"), posts ("Iowa State", "USC") and The Odds API
// ("Iowa State Cyclones", "USC Trojans").

import aliasTable from "./team_aliases.json" with { type: "json" };

/** "Saint Mary's" / "St. Mary's" -> "st marys", "Iowa State" / "Iowa St." -> "iowa st". */
export function baseKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/&amp;/g, "&")
    .replace(/[.'’]/g, "")
    .replace(/\bsaint\b/g, "st")
    .replace(/\bstate\b/g, "st")
    .replace(/\s+/g, " ")
    .trim();
}

// Common spellings -> NCAA scoreboard short names ("USC" -> "Southern California"),
// shared with scripts/import_league.py.
const ALIASES = new Map(Object.entries(aliasTable).map(([spelling, ncaa]) => [baseKey(spelling), baseKey(ncaa)]));

/** Comparison key for a team name, with common spellings mapped to the NCAA name. */
export function teamKey(name: string): string {
  const key = baseKey(name);
  return ALIASES.get(key) ?? ALIASES.get(key.replace(/^the /, "")) ?? key;
}

/**
 * Every spelling an NCAA name might start with in another source: the name itself, the
 * name without a "(CA)"-style suffix, and every alias that maps to it.
 */
export function nameVariants(ncaaName: string): string[] {
  const key = baseKey(ncaaName);
  const variants = new Set([key, key.replace(/\s*\([^)]*\)\s*$/, "")]);
  for (const [spelling, target] of ALIASES) if (target === key) variants.add(spelling);
  return [...variants].filter(Boolean);
}
