// POST /functions/v1/sync-buy-games    body: {} or {"dryRun": true}
//
// Reads a feed of posts (BUY_GAME_FEED_URL, e.g. a self-hosted RSSHub route for
// @JonRothstein), finds "<Team> loses a buy game to <Team>." posts, matches each one to a
// finished game in the league's games table and records a -2 buy_game_loss adjustment for
// the rostered loser. The post's URL is stored as source_url, so re-running is safe; a team
// that already has a buy_game_loss for that game day (e.g. entered by hand) is skipped.

import {
  BUY_GAME_PENALTY,
  type BuyGamePost,
  canonicalPostUrl,
  findBuyGame,
  LOOKBACK_DAYS,
  parseBuyGamePost,
  type StoredGame,
} from "../_shared/buygame.ts";
import { addDays, gameDay } from "../_shared/dates.ts";
import { HttpError, isServiceRoleRequest, json, readJsonBody, serviceClient } from "../_shared/http.ts";
import { fetchFeed } from "../_shared/rss.ts";

type Body = { dryRun?: boolean };
type Candidate = BuyGamePost & { url: string; postDay: string; text: string };

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "Use POST." });
  if (!isServiceRoleRequest(req)) return json(401, { error: "Service role key required." });

  const feedUrl = Deno.env.get("BUY_GAME_FEED_URL");
  // Not an error: the feed is optional, and pg_cron shouldn't log failures every run.
  if (!feedUrl) return json(200, { skipped: "BUY_GAME_FEED_URL is not set." });

  try {
    const { dryRun = false } = await readJsonBody<Body>(req);
    const items = await fetchFeed(feedUrl);

    const candidates: Candidate[] = [];
    for (const item of items) {
      const post = parseBuyGamePost(item.title) ?? parseBuyGamePost(item.text);
      const when = new Date(item.pubDate);
      if (!post || !item.link || Number.isNaN(when.getTime())) continue;
      candidates.push({ ...post, url: canonicalPostUrl(item.link), postDay: gameDay(when), text: item.title });
    }
    const summary = {
      feedItems: items.length,
      buyGamePosts: candidates.length,
      recorded: [] as Record<string, unknown>[],
      alreadyRecorded: [] as string[],
      // Posts whose loser has no matching loss in the games table. The table only holds games
      // involving a rostered team, so this is usually a team nobody in the league owns.
      noLeagueGame: [] as { post: string; url: string }[],
      dryRun,
    };
    if (candidates.length === 0) return json(200, summary);

    const db = serviceClient();
    const days = candidates.map((c) => c.postDay).sort();
    const [games, seasons, known] = await Promise.all([
      db.from("games")
        .select("ncaa_game_id, game_date, is_final, home_team, home_score, away_team, away_score")
        .gte("game_date", addDays(days[0], -LOOKBACK_DAYS))
        .lte("game_date", days[days.length - 1]),
      db.from("seasons").select("id, start_date, end_date"),
      db.from("point_adjustments").select("season_id, team_name, game_date, source_url").eq("kind", "buy_game_loss"),
    ]);
    for (const r of [games, seasons, known]) if (r.error) throw r.error;

    const seenUrls = new Set(known.data!.map((a) => a.source_url).filter(Boolean));
    const seenGames = new Set(known.data!.map((a) => `${a.season_id}|${a.team_name}|${a.game_date}`));

    for (const c of candidates) {
      if (seenUrls.has(c.url)) {
        summary.alreadyRecorded.push(c.url);
        continue;
      }
      const match = findBuyGame(c, c.postDay, games.data as StoredGame[]);
      const season = match &&
        seasons.data!.find((s) => s.start_date <= match.game.game_date && match.game.game_date <= s.end_date);
      if (!match || !season) {
        summary.noLeagueGame.push({ post: c.text, url: c.url });
        continue;
      }

      const { data: rostered, error: rosterErr } = await db.from("rosters").select("team_name")
        .eq("season_id", season.id).eq("team_name", match.loser).maybeSingle();
      if (rosterErr) throw rosterErr;
      if (!rostered) {
        // The game is stored because the winner is rostered; the loser isn't, so no penalty.
        summary.noLeagueGame.push({ post: c.text, url: c.url });
        continue;
      }

      const gameKey = `${season.id}|${match.loser}|${match.game.game_date}`;
      if (seenGames.has(gameKey)) {
        summary.alreadyRecorded.push(c.url);
        continue;
      }

      const g = match.game;
      const row = {
        season_id: season.id,
        team_name: match.loser,
        points: BUY_GAME_PENALTY,
        kind: "buy_game_loss",
        game_date: g.game_date,
        note: `Lost to ${match.winner} ${Math.max(g.home_score!, g.away_score!)}-${
          Math.min(g.home_score!, g.away_score!)
        } (${g.home_team === match.loser ? "home" : "away"})`,
        source_url: c.url,
      };
      if (!dryRun) {
        const { error } = await db.from("point_adjustments").insert(row);
        if (error?.code === "23505") { // source_url unique index: another run got there first
          summary.alreadyRecorded.push(c.url);
          continue;
        }
        if (error) throw error;
      }
      seenUrls.add(c.url);
      seenGames.add(gameKey);
      summary.recorded.push(row);
    }

    return json(200, summary);
  } catch (err) {
    if (err instanceof HttpError) return json(err.status, { error: err.message });
    console.error("sync-buy-games:", err);
    return json(500, { error: err instanceof Error ? err.message : String(err) });
  }
});
