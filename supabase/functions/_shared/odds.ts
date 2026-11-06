// The Odds API (the-odds-api.com) -> lines for league games. Pure functions are exported
// for tests; update-odds does the I/O.
//
// Cost: each /odds call uses (markets x regions) credits, so h2h + spreads in "us" = 2.

import { baseKey, nameVariants } from "./names.ts";

export const SPORT = "basketball_ncaab";
export const MARKETS = "h2h,spreads";
/** Books to take the line from, in order; otherwise the first book that has the game. */
export const PREFERRED_BOOKMAKERS = ["draftkings", "fanduel", "betmgm", "caesars"];

type Outcome = { name: string; price: number; point?: number };
type Market = { key: string; outcomes: Outcome[] };
type Bookmaker = { key: string; title: string; markets: Market[] };
export type OddsEvent = {
  id: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers?: Bookmaker[];
};

export type Line = {
  homeMoneyline: number | null;
  awayMoneyline: number | null;
  homeSpread: number | null;
  bookmaker: string;
};

export type Usage = { remaining: number | null; used: number | null; last: number | null };

export async function fetchOdds(
  apiKey: string,
  host = "https://api.the-odds-api.com",
  window: { from: Date; to: Date },
): Promise<{ events: OddsEvent[]; usage: Usage }> {
  // The API wants second precision: 2026-11-06T15:00:00Z
  const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
  const params = new URLSearchParams({
    apiKey,
    regions: "us",
    markets: MARKETS,
    oddsFormat: "american",
    commenceTimeFrom: iso(window.from),
    commenceTimeTo: iso(window.to),
  });
  const res = await fetch(`${host}/v4/sports/${SPORT}/odds/?${params}`, { signal: AbortSignal.timeout(30_000) });
  const num = (h: string) => {
    const v = res.headers.get(h);
    return v === null || v === "" ? null : Number(v);
  };
  const usage = { remaining: num("x-requests-remaining"), used: num("x-requests-used"), last: num("x-requests-last") };
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    // Don't include the URL: it contains the API key.
    throw new Error(`Odds API error ${res.status}: ${detail}`);
  }
  return { events: (await res.json()) as OddsEvent[], usage };
}

/** Moneyline and spread for one event, all from the same bookmaker. */
export function pickLine(event: OddsEvent): Line | null {
  const books = [...(event.bookmakers ?? [])].sort((a, b) => rank(a.key) - rank(b.key));
  const book = books.find((b) => hasMarket(b, "h2h") && hasMarket(b, "spreads")) ??
    books.find((b) => hasMarket(b, "h2h") || hasMarket(b, "spreads"));
  if (!book) return null;

  const outcome = (market: string, team: string) =>
    book.markets.find((m) => m.key === market)?.outcomes.find((o) => o.name === team);
  const homeSpread = outcome("spreads", event.home_team)?.point ??
    negate(outcome("spreads", event.away_team)?.point);
  return {
    homeMoneyline: outcome("h2h", event.home_team)?.price ?? null,
    awayMoneyline: outcome("h2h", event.away_team)?.price ?? null,
    homeSpread: homeSpread ?? null,
    bookmaker: book.title,
  };
}

function rank(key: string): number {
  const i = PREFERRED_BOOKMAKERS.indexOf(key);
  return i === -1 ? PREFERRED_BOOKMAKERS.length : i;
}
const hasMarket = (b: Bookmaker, key: string) => b.markets.some((m) => m.key === key && m.outcomes.length >= 2);
const negate = (n: number | undefined) => (n === undefined ? undefined : -n);

/**
 * How well an Odds API name ("Iowa State Cyclones") fits an NCAA name ("Iowa St."):
 * the length of the longest NCAA spelling it starts with (mascots come after), or 0.
 */
export function nameScore(oddsName: string, ncaaName: string): number {
  const key = baseKey(oddsName);
  let best = 0;
  for (const v of nameVariants(ncaaName)) {
    if ((key === v || key.startsWith(v + " ")) && v.length > best) best = v.length;
  }
  return best;
}

export type LeagueGame = { ncaa_game_id: string; start_time: string | null; home_team: string; away_team: string };
export type OddsMatch = { game: LeagueGame; event: OddsEvent; swapped: boolean };

/** Games whose start times are this close count as the same game. */
const MAX_START_DIFF_MS = 3 * 60 * 60 * 1000;

/**
 * Pairs Odds API events with league games. Both team names must match and the start
 * times must be close. Home/away may be listed the other way round (neutral sites), in
 * which case swapped is true. Each game and event is used at most once, best fit first.
 */
export function matchOdds(events: OddsEvent[], games: LeagueGame[]): OddsMatch[] {
  const pairs: (OddsMatch & { score: number })[] = [];
  for (const event of events) {
    const commence = Date.parse(event.commence_time);
    for (const game of games) {
      if (game.start_time && Math.abs(Date.parse(game.start_time) - commence) > MAX_START_DIFF_MS) continue;
      const straight = both(nameScore(event.home_team, game.home_team), nameScore(event.away_team, game.away_team));
      const swapped = both(nameScore(event.home_team, game.away_team), nameScore(event.away_team, game.home_team));
      if (straight > 0 && straight >= swapped) pairs.push({ game, event, swapped: false, score: straight });
      else if (swapped > 0) pairs.push({ game, event, swapped: true, score: swapped });
    }
  }
  pairs.sort((a, b) => b.score - a.score);
  const usedGames = new Set<string>();
  const usedEvents = new Set<string>();
  const out: OddsMatch[] = [];
  for (const p of pairs) {
    if (usedGames.has(p.game.ncaa_game_id) || usedEvents.has(p.event.id)) continue;
    usedGames.add(p.game.ncaa_game_id);
    usedEvents.add(p.event.id);
    out.push({ game: p.game, event: p.event, swapped: p.swapped });
  }
  return out;
}
const both = (a: number, b: number) => (a > 0 && b > 0 ? a + b : 0);

/** The line from the NCAA home team's point of view. */
export function lineForGame(line: Line, swapped: boolean): Line {
  if (!swapped) return line;
  return {
    homeMoneyline: line.awayMoneyline,
    awayMoneyline: line.homeMoneyline,
    homeSpread: line.homeSpread === null ? null : -line.homeSpread,
    bookmaker: line.bookmaker,
  };
}
