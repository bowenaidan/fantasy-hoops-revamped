// POST /functions/v1/sync-scores
//
// Pulls the NCAA scoreboard for one or more game days, stores games involving
// rostered teams, and rewrites that day's scoring ledger. Safe to re-run: each day
// is replaced atomically by public.apply_day_sync().
//
// Body (all optional):
//   {}                                         -> current game day
//   { "date": "yesterday" }                    -> previous game day
//   { "date": "2026-11-20" }                   -> that day
//   { "startDate": "...", "endDate": "..." }   -> inclusive range (max MAX_DAYS_PER_CALL)
//
// Replaces dailySync / settleScores / updateOpponentCellsForDate from the Sheets version.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { addDays, dateRange, gameDay, isIsoDate } from "../_shared/dates.ts";
import { HttpError, isServiceRoleRequest, json, readJsonBody, serviceClient, sleep } from "../_shared/http.ts";
import { DEFAULT_NCAA_API_BASE, fetchScoreboard, type NormalizedGame, normalizeSchoolName } from "../_shared/ncaa.ts";
import {
  calculateGamePoints,
  isGameFinal,
  scoreGame,
  type TeamTierOverrides,
  type Tier,
  type TierMap,
  unknownConferences,
} from "../_shared/scoring.ts";

const MAX_DAYS_PER_CALL = 31;
// Keep well under the public NCAA API's ~5 req/s limit during backfills.
const REQUEST_SPACING_MS = 300;

type SyncRequest = { date?: string; startDate?: string; endDate?: string };

type Season = { id: number; label: string; start_date: string; end_date: string };

type DayResult = {
  date: string;
  status: "synced" | "skipped" | "error";
  detail?: string;
  gamesStored?: number;
  pointEntries?: number;
  pointsAwarded?: number;
  unknownConferences?: string[];
};

function resolveDates(body: SyncRequest): string[] {
  const today = gameDay();
  if (body.startDate || body.endDate) {
    const start = body.startDate;
    const end = body.endDate ?? today;
    if (!isIsoDate(start) || !isIsoDate(end)) throw new HttpError(400, "startDate and endDate must be YYYY-MM-DD.");
    if (start > end) throw new HttpError(400, "startDate must be on or before endDate.");
    const dates = dateRange(start, end > today ? today : end);
    if (dates.length > MAX_DAYS_PER_CALL) {
      throw new HttpError(400, `Range is ${dates.length} days; max is ${MAX_DAYS_PER_CALL}. Split it into chunks.`);
    }
    return dates;
  }
  const date = body.date ?? "today";
  if (date === "today") return [today];
  if (date === "yesterday") return [addDays(today, -1)];
  if (!isIsoDate(date)) throw new HttpError(400, 'date must be "today", "yesterday", or YYYY-MM-DD.');
  return [date];
}

function toGameRow(
  game: NormalizedGame,
  homeName: string,
  awayName: string,
  tiers: TierMap,
  overrides: TeamTierOverrides,
) {
  return {
    ncaa_game_id: game.gameID,
    start_time: game.startTime,
    game_state: game.gameState,
    current_period: game.currentPeriod,
    contest_clock: game.contestClock,
    final_message: game.finalMessage,
    is_final: isGameFinal(game),
    home_team: homeName,
    home_score: game.home.score,
    home_rank: game.home.rank,
    home_conference: game.home.conferenceSeo,
    home_winner: game.home.winner,
    home_potential_points: calculateGamePoints(game, true, tiers, overrides),
    away_team: awayName,
    away_score: game.away.score,
    away_rank: game.away.rank,
    away_conference: game.away.conferenceSeo,
    away_winner: game.away.winner,
    away_potential_points: calculateGamePoints(game, false, tiers, overrides),
    raw: game.raw,
  };
}

/** Normalized scoreboard name -> rostered team name, cached per season. */
async function rosterLookup(
  db: SupabaseClient,
  cache: Map<number, Map<string, string>>,
  seasonId: number,
): Promise<Map<string, string>> {
  let lookup = cache.get(seasonId);
  if (!lookup) {
    const { data, error } = await db.from("rosters").select("team_name").eq("season_id", seasonId);
    if (error) throw error;
    lookup = new Map(data.map((r) => [normalizeSchoolName(r.team_name), r.team_name as string]));
    cache.set(seasonId, lookup);
  }
  return lookup;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "Use POST." });
  if (!isServiceRoleRequest(req)) return json(401, { error: "Service role key required." });

  try {
    const dates = resolveDates(await readJsonBody<SyncRequest>(req));
    const db = serviceClient();
    const ncaaBase = Deno.env.get("NCAA_API_BASE") ?? DEFAULT_NCAA_API_BASE;

    const [
      { data: tierRows, error: tierErr },
      { data: seasons, error: seasonErr },
      { data: overrideRows, error: overrideErr },
    ] = await Promise.all([
      db.from("conference_tiers").select("conference_seo, tier"),
      db.from("seasons").select("id, label, start_date, end_date"),
      db.from("teams").select("name, nonconference_tier").not("nonconference_tier", "is", null),
    ]);
    if (tierErr) throw tierErr;
    if (seasonErr) throw seasonErr;
    if (overrideErr) throw overrideErr;
    if (!tierRows?.length) {
      throw new HttpError(500, "conference_tiers is empty; every team would be scored as non-D1.");
    }
    const tiers: TierMap = new Map(tierRows.map((r) => [r.conference_seo.toLowerCase(), r.tier as Tier]));
    const overrides: TeamTierOverrides = new Map(
      (overrideRows ?? []).map((r) => [normalizeSchoolName(r.name), r.nonconference_tier as Tier]),
    );

    const rosterCache = new Map<number, Map<string, string>>();
    const results: DayResult[] = [];
    for (const [i, date] of dates.entries()) {
      const season = (seasons as Season[]).find((s) => s.start_date <= date && date <= s.end_date);
      if (!season) {
        results.push({ date, status: "skipped", detail: "No season covers this date." });
        continue;
      }

      try {
        if (i > 0) await sleep(REQUEST_SPACING_MS);
        const roster = await rosterLookup(db, rosterCache, season.id);
        if (roster.size === 0) {
          results.push({ date, status: "skipped", detail: `Season ${season.label} has no rosters.` });
          continue;
        }

        const games = await fetchScoreboard(date, ncaaBase);
        if (games.length === 0) {
          // Don't wipe stored data because of an empty/odd upstream response.
          results.push({ date, status: "skipped", detail: "Scoreboard returned no games." });
          continue;
        }

        const rosterName = (name: string | null) => roster.get(normalizeSchoolName(name));
        const relevant = games.filter((g) => g.gameID && (rosterName(g.home.name) || rosterName(g.away.name)));

        // Dedupe by game id (the scoreboard occasionally repeats a game).
        const gameRows = [
          ...new Map(
            relevant.map((g) => [
              g.gameID,
              toGameRow(
                g,
                rosterName(g.home.name) ?? g.home.name!,
                rosterName(g.away.name) ?? g.away.name!,
                tiers,
                overrides,
              ),
            ]),
          ).values(),
        ];
        const points = [
          ...new Map(
            relevant.flatMap((g) => scoreGame(g, rosterName, tiers, overrides)).map((
              p,
            ) => [`${p.ncaa_game_id}|${p.team_name}`, p]),
          ).values(),
        ];

        const { error } = await db.rpc("apply_day_sync", {
          p_season_id: season.id,
          p_game_date: date,
          p_games: gameRows,
          p_points: points,
        });
        if (error) throw error;

        const unknown = unknownConferences(relevant, tiers);
        results.push({
          date,
          status: "synced",
          gamesStored: gameRows.length,
          pointEntries: points.length,
          pointsAwarded: points.reduce((sum, p) => sum + p.points, 0),
          ...(unknown.length ? { unknownConferences: unknown } : {}),
        });
      } catch (err) {
        console.error(`sync-scores ${date}:`, err);
        results.push({ date, status: "error", detail: err instanceof Error ? err.message : String(err) });
      }
    }

    const failed = results.filter((r) => r.status === "error").length;
    return json(failed === results.length ? 502 : 200, { results });
  } catch (err) {
    if (err instanceof HttpError) return json(err.status, { error: err.message });
    console.error("sync-scores:", err);
    return json(500, { error: err instanceof Error ? err.message : String(err) });
  }
});
