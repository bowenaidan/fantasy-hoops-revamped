// POST /functions/v1/update-odds
//
// Fetches NCAAB moneyline odds from the-odds-api. Not yet matched to games: The Odds
// API uses full school names ("Michigan State Spartans") that need a mapping to the
// NCAA short names before games.home_odds / away_odds can be filled in.
//
// Service-role only: every call spends the Odds API's monthly request quota.

import { isServiceRoleRequest, json } from "../_shared/http.ts";

const SPORT = "basketball_ncaab";

export async function fetchOdds(apiKey: string, host = "https://api.the-odds-api.com"): Promise<unknown[]> {
  const params = new URLSearchParams({ apiKey, regions: "us", markets: "h2h", oddsFormat: "american" });
  const res = await fetch(`${host}/v4/sports/${SPORT}/odds/?${params}`);
  if (!res.ok) {
    await res.body?.cancel();
    // Don't include the URL: it contains the API key.
    throw new Error(`Odds API error: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as unknown[];
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "Use POST." });
  if (!isServiceRoleRequest(req)) return json(401, { error: "Service role key required." });

  const apiKey = Deno.env.get("ODDS_API_KEY");
  if (!apiKey) return json(500, { error: "ODDS_API_KEY is not set." });

  try {
    const odds = await fetchOdds(apiKey, Deno.env.get("ODDS_API_HOST") || undefined);
    return json(200, { gamesAvailable: odds.length, odds });
  } catch (err) {
    console.error("update-odds:", err);
    return json(502, { error: err instanceof Error ? err.message : String(err) });
  }
});
