// POST /functions/v1/update-odds
//
// Fetches NCAAB moneylines and spreads from The Odds API and stores them on today's league
// games that haven't started yet (games.home_odds / away_odds / home_spread). Games that
// have tipped off keep their last pre-game line.
//
// Service-role only: every call spends 2 credits of the Odds API's monthly quota
// (h2h + spreads, US books). The response reports the credits left.

import { gameDay } from "../_shared/dates.ts";
import { isServiceRoleRequest, json, serviceClient } from "../_shared/http.ts";
import { fetchOdds, type LeagueGame, lineForGame, matchOdds, pickLine } from "../_shared/odds.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "Use POST." });
  if (!isServiceRoleRequest(req)) return json(401, { error: "Service role key required." });

  const apiKey = Deno.env.get("ODDS_API_KEY");
  if (!apiKey) return json(500, { error: "ODDS_API_KEY is not set." });

  try {
    const db = serviceClient();
    // Look before spending credits: nothing to do if no league game is still to come today.
    const { data: games, error } = await db.from("games")
      .select("ncaa_game_id, start_time, home_team, away_team")
      .eq("game_date", gameDay())
      .or("game_state.is.null,game_state.eq.pre");
    if (error) throw error;
    if (games.length === 0) return json(200, { skipped: "No upcoming league games today.", creditsUsed: 0 });

    const now = new Date();
    const { events, usage } = await fetchOdds(apiKey, Deno.env.get("ODDS_API_HOST") || undefined, {
      from: now,
      to: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    });

    const matches = matchOdds(events, games as LeagueGame[]);
    const updated: string[] = [];
    for (const m of matches) {
      const line = pickLine(m.event);
      if (!line) continue;
      const l = lineForGame(line, m.swapped);
      const { error: upErr } = await db.from("games").update({
        home_odds: l.homeMoneyline,
        away_odds: l.awayMoneyline,
        home_spread: l.homeSpread,
        odds_bookmaker: l.bookmaker,
        odds_updated_at: new Date().toISOString(),
      }).eq("ncaa_game_id", m.game.ncaa_game_id);
      if (upErr) throw upErr;
      updated.push(`${m.game.away_team} at ${m.game.home_team}`);
    }

    const matchedIds = new Set(matches.map((m) => m.game.ncaa_game_id));
    return json(200, {
      creditsUsed: usage.last,
      creditsRemaining: usage.remaining,
      oddsEvents: events.length,
      updated,
      // Usually small schools with no line. If a big game is listed here, its Odds API
      // spelling needs an entry in _shared/team_aliases.json.
      noLine: games.filter((g) => !matchedIds.has(g.ncaa_game_id)).map((g) => `${g.away_team} at ${g.home_team}`),
    });
  } catch (err) {
    console.error("update-odds:", err);
    return json(502, { error: err instanceof Error ? err.message : String(err) });
  }
});
