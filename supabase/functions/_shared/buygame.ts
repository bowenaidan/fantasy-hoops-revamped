// Buy-game detection from a feed of posts like:
//   "Rice loses a buy game to East Texas A&M.  The epitome of brutality."
// Pure functions only, so they can be unit tested; sync-buy-games does the I/O.

import { addDays } from "./dates.ts";
import aliasTable from "./team_aliases.json" with { type: "json" };

/** Points for a rostered team that loses a buy game (Point Structure sheet). */
export const BUY_GAME_PENALTY = -2;

export type BuyGamePost = { loser: string; winner: string };

const POST_PATTERN =
  /^\s*(?:RT\s+)?(.+?)\s+(?:loses|drops|falls in)\s+(?:a\s+)?buy\s+game\s+(?:to|against|vs\.?)\s+(.+?)(?:[.!?](?:\s|$)|\n|$)/i;

/** Pulls loser/winner out of a post, or null if it isn't a buy-game post. */
export function parseBuyGamePost(text: string): BuyGamePost | null {
  // Keep line breaks: a post's first line ends the sentence even without a period.
  const m = POST_PATTERN.exec(text.replace(/\r/g, "").replace(/[^\S\n]+/g, " "));
  if (!m) return null;
  // Drop a trailing score ("East Texas A&M 68-64") and surrounding punctuation.
  const clean = (s: string) => s.replace(/\s+\d+\s*-\s*\d+.*$/, "").replace(/^[\s"'“”]+|[\s"'“”,;:]+$/g, "");
  const loser = clean(m[1]);
  const winner = clean(m[2]);
  return loser && winner ? { loser, winner } : null;
}

/** "Saint Mary's" / "St. Mary's" -> "st marys", "Iowa State" / "Iowa St." -> "iowa st". */
function baseKey(name: string): string {
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

/** One URL per post (twitter.com and x.com links, with or without ?query), for dedupe. */
export function canonicalPostUrl(link: string): string {
  return link.trim().replace(/[?#].*$/, "").replace(
    /^https?:\/\/(www\.|mobile\.)?(twitter|x)\.com\//i,
    "https://x.com/",
  );
}

export type StoredGame = {
  ncaa_game_id: string;
  game_date: string;
  is_final: boolean;
  home_team: string;
  home_score: number | null;
  away_team: string;
  away_score: number | null;
};

export type BuyGameMatch = { game: StoredGame; loser: string; winner: string };

/** How many days before the post the game may have been played (posts come late at night). */
export const LOOKBACK_DAYS = 2;

/**
 * Finds the finished game the post is about: the named loser lost it, on the post's game day
 * or up to LOOKBACK_DAYS before. If the winner's name also matches, that game wins outright;
 * otherwise a single loss by the loser in the window is accepted. Anything ambiguous is null.
 */
export function findBuyGame(post: BuyGamePost, postGameDay: string, games: StoredGame[]): BuyGameMatch | null {
  const earliest = addDays(postGameDay, -LOOKBACK_DAYS);
  const loserKey = teamKey(post.loser);
  const winnerKey = teamKey(post.winner);

  const losses: BuyGameMatch[] = [];
  for (const g of games) {
    if (!g.is_final || g.home_score === null || g.away_score === null) continue;
    if (g.game_date < earliest || g.game_date > postGameDay) continue;
    if (g.home_score === g.away_score) continue;
    const homeWon = g.home_score > g.away_score;
    const loser = homeWon ? g.away_team : g.home_team;
    const winner = homeWon ? g.home_team : g.away_team;
    if (teamKey(loser) === loserKey) losses.push({ game: g, loser, winner });
  }

  const exact = losses.filter((m) => teamKey(m.winner) === winnerKey);
  if (exact.length === 1) return exact[0];
  if (exact.length === 0 && losses.length === 1) return losses[0];
  return null;
}
