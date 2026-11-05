// POST /functions/v1/sync-rankings
//
// Updates teams.ap_rank from the current AP Top 25 (replaces teamRankUpdate.js).
// Scoring itself uses the rank shown on the scoreboard at game time; this is for display.

import { isServiceRoleRequest, json, serviceClient } from "../_shared/http.ts";
import { apMatchKey, DEFAULT_NCAA_API_BASE, fetchApPoll } from "../_shared/ncaa.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "Use POST." });
  if (!isServiceRoleRequest(req)) return json(401, { error: "Service role key required." });

  try {
    const poll = await fetchApPoll(Deno.env.get("NCAA_API_BASE") ?? DEFAULT_NCAA_API_BASE);
    if (poll.length === 0) {
      // Don't clear every rank because the upstream page was empty.
      return json(502, { error: "AP poll returned no rankings; nothing changed." });
    }
    const rankByKey = new Map(poll.map((e) => [apMatchKey(e.school), e.rank]));

    const db = serviceClient();
    const { data: teams, error } = await db.from("teams").select("name");
    if (error) throw error;

    const ranks = teams
      .map((t) => ({ team_name: t.name as string, ap_rank: rankByKey.get(apMatchKey(t.name)) ?? null }))
      .filter((r) => r.ap_rank !== null);

    const { data: changed, error: rpcErr } = await db.rpc("apply_ap_rankings", { p_ranks: ranks });
    if (rpcErr) throw rpcErr;

    const matched = new Set(ranks.map((r) => apMatchKey(r.team_name)));
    return json(200, {
      rankedTeamsInLeague: ranks.length,
      teamsChanged: changed,
      // Poll teams that didn't match any league team, to catch naming mismatches.
      unmatchedPollTeams: poll.filter((e) => !matched.has(apMatchKey(e.school))).map((e) => e.school),
    });
  } catch (err) {
    console.error("sync-rankings:", err);
    return json(500, { error: err instanceof Error ? err.message : String(err) });
  }
});
