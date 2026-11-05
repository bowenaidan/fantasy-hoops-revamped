// Fantasy Hoops scoring rules. Pure functions only (no I/O) so they can be unit
// tested and reused by the Next.js app if needed.
//
// Ported from the Apps Script version (scoreUpdate.js). Intentional differences:
//   - isGameFinal accepts "FINAL - OT" etc. The original compared currentPeriod to
//     exactly "final", so overtime wins were never scored.
//   - Conference tiers are passed in (they live in the conference_tiers table).

import type { NormalizedGame } from "./ncaa.ts";

export type Tier = "highMajor" | "highMid" | "trueMid" | "lowMajor";
export type TierMap = ReadonlyMap<string, Tier>;

const TIER_LEVEL: Record<Tier, number> = { highMajor: 3, highMid: 2, trueMid: 1, lowMajor: 0 };

/** Points for an in-conference win, by tier. */
const CONF_POINTS: Record<Tier, { home: number; road: number }> = {
  highMajor: { home: 3.5, road: 5 },
  highMid: { home: 2.5, road: 4 },
  trueMid: { home: 1.5, road: 2.5 },
  lowMajor: { home: 1, road: 1.5 },
};

/** Applied when a non-D1 team (unknown conference) wins: to the winner's points and to a rostered loser. */
export const NON_D1_PENALTY = 4;
const NON_D1_LEVEL = -1;

export function tierLevel(conferenceSeo: string | null | undefined, tiers: TierMap): number {
  const tier = conferenceSeo ? tiers.get(conferenceSeo.toLowerCase()) : undefined;
  return tier ? TIER_LEVEL[tier] : NON_D1_LEVEL;
}

/** Points the given side earns for winning this game. */
export function calculateGamePoints(
  game: NormalizedGame,
  winnerIsHome: boolean,
  tiers: TierMap,
): number {
  const homeConf = game.home.conferenceSeo?.toLowerCase() ?? null;
  const awayConf = game.away.conferenceSeo?.toLowerCase() ?? null;
  const loserRank = winnerIsHome ? game.away.rank : game.home.rank;

  let points = 0;

  if (homeConf && awayConf && homeConf === awayConf) {
    const tier = tiers.get(homeConf);
    if (tier) points = CONF_POINTS[tier][winnerIsHome ? "home" : "road"];
  } else {
    const winnerLevel = tierLevel(winnerIsHome ? homeConf : awayConf, tiers);
    const loserLevel = tierLevel(winnerIsHome ? awayConf : homeConf, tiers);
    // Beating a peer is worth 2, each tier "up" adds 2, beating a lower tier is worth 0.
    const diff = loserLevel - winnerLevel;
    if (diff + 1 > 0) points = (diff + 1) * 2;
    if (winnerLevel === NON_D1_LEVEL) points -= NON_D1_PENALTY;
  }

  if (loserRank !== null && loserRank >= 1 && loserRank <= 25) {
    points += loserRank <= 10 ? 5 : 2.5;
  }

  return points;
}

export function isGameFinal(game: NormalizedGame): boolean {
  const { home, away } = game;
  if (!home.name || !away.name) return false;

  // Scores must agree with the winner flags.
  if (home.score !== null && away.score !== null) {
    if (home.score === away.score) return false;
    const homeWonOnScore = home.score > away.score;
    if (homeWonOnScore !== home.winner) return false;
    if (homeWonOnScore === away.winner) return false;
  }

  const period = (game.currentPeriod ?? "").toLowerCase();
  const finalMessage = (game.finalMessage ?? "").toLowerCase();
  const state = (game.gameState ?? "").toLowerCase();
  const hasWinner = home.winner || away.winner;

  return hasWinner &&
    (period.startsWith("final") || period === "finished") &&
    (finalMessage === "" || finalMessage.startsWith("final")) &&
    (state === "final" || state === "post" || state === "complete" || game.contestClock === "0:00");
}

export type PointEntry = {
  ncaa_game_id: string;
  team_name: string;
  points: number;
  reason: "win" | "loss_to_non_d1";
};

/**
 * Ledger entries for one game. `rosterName` maps a scoreboard team name to the
 * rostered team's canonical name, or undefined if nobody drafted that team.
 */
export function scoreGame(
  game: NormalizedGame,
  rosterName: (scoreboardName: string | null) => string | undefined,
  tiers: TierMap,
): PointEntry[] {
  if (!game.gameID || !isGameFinal(game)) return [];

  const winnerIsHome = game.home.winner;
  const winner = winnerIsHome ? game.home : game.away;
  const loser = winnerIsHome ? game.away : game.home;
  const winnerRoster = rosterName(winner.name);
  const loserRoster = rosterName(loser.name);
  const entries: PointEntry[] = [];

  if (winnerRoster) {
    entries.push({
      ncaa_game_id: game.gameID,
      team_name: winnerRoster,
      points: calculateGamePoints(game, winnerIsHome, tiers),
      reason: "win",
    });
  }
  if (loserRoster && tierLevel(winner.conferenceSeo, tiers) === NON_D1_LEVEL) {
    entries.push({
      ncaa_game_id: game.gameID,
      team_name: loserRoster,
      points: -NON_D1_PENALTY,
      reason: "loss_to_non_d1",
    });
  }
  return entries;
}

/** Conference SEOs in these games that have no tier (and so are scored as non-D1). */
export function unknownConferences(games: NormalizedGame[], tiers: TierMap): string[] {
  const unknown = new Set<string>();
  for (const g of games) {
    for (const side of [g.home, g.away]) {
      if (side.conferenceSeo && !tiers.has(side.conferenceSeo)) unknown.add(side.conferenceSeo);
    }
  }
  return [...unknown].sort();
}
