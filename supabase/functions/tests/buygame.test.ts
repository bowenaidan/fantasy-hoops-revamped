import { assertEquals } from "jsr:@std/assert@1";
import { canonicalPostUrl, findBuyGame, parseBuyGamePost, type StoredGame } from "../_shared/buygame.ts";
import { teamKey } from "../_shared/names.ts";

Deno.test("parses buy-game posts", () => {
  assertEquals(
    parseBuyGamePost("Rice loses a buy game to East Texas A&M.  The epitome of brutality."),
    { loser: "Rice", winner: "East Texas A&M" },
  );
  assertEquals(
    parseBuyGamePost("Oklahoma loses a buy game to East Texas A&M\n\nThe epitome of brutality."),
    { loser: "Oklahoma", winner: "East Texas A&M" },
  );
  assertEquals(parseBuyGamePost("Saint Mary's loses a BUY GAME to UC San Diego 70-65!"), {
    loser: "Saint Mary's",
    winner: "UC San Diego",
  });
  assertEquals(parseBuyGamePost("St. John's drops a buy game to Iona."), { loser: "St. John's", winner: "Iona" });
  assertEquals(parseBuyGamePost("Duke beats Army. Never a buy game."), null);
  assertEquals(parseBuyGamePost("Kentucky. Ball don't lie."), null);
});

Deno.test("team keys accept common spellings", () => {
  assertEquals(teamKey("Iowa State"), teamKey("Iowa St."));
  assertEquals(teamKey("USC"), teamKey("Southern California"));
  assertEquals(teamKey("Saint Mary's"), teamKey("Saint Mary's (CA)"));
  assertEquals(teamKey("East Texas A&amp;M"), teamKey("East Texas A&M"));
});

Deno.test("canonical post URLs", () => {
  assertEquals(
    canonicalPostUrl("https://twitter.com/JonRothstein/status/123?s=20"),
    "https://x.com/JonRothstein/status/123",
  );
  assertEquals(canonicalPostUrl("https://x.com/JonRothstein/status/123"), "https://x.com/JonRothstein/status/123");
});

const game = (id: string, date: string, home: string, hs: number, away: string, as: number): StoredGame => ({
  ncaa_game_id: id,
  game_date: date,
  is_final: true,
  home_team: home,
  home_score: hs,
  away_team: away,
  away_score: as,
});

Deno.test("matches the post to the loser's game", () => {
  const games = [
    game("1", "2026-11-02", "Oklahoma", 64, "East Texas A&M", 68),
    game("2", "2026-11-02", "Rice", 70, "Lamar University", 60),
    game("3", "2026-10-25", "Oklahoma", 50, "Somebody", 60), // outside the lookback window
  ];
  const post = { loser: "Oklahoma", winner: "East Texas A&M" };
  assertEquals(findBuyGame(post, "2026-11-02", games)?.game.ncaa_game_id, "1");
  assertEquals(findBuyGame(post, "2026-11-03", games)?.loser, "Oklahoma"); // posted the next day
  assertEquals(findBuyGame(post, "2026-11-10", games), null); // too late
  assertEquals(findBuyGame({ loser: "Rice", winner: "Lamar" }, "2026-11-02", games), null); // Rice won
});

Deno.test("winner name breaks ties, otherwise ambiguity is rejected", () => {
  const games = [
    game("1", "2026-11-02", "Kansas", 60, "UMKC", 62),
    game("2", "2026-11-03", "Kansas", 55, "Southern U.", 58),
  ];
  assertEquals(findBuyGame({ loser: "Kansas", winner: "Southern" }, "2026-11-03", games)?.game.ncaa_game_id, "2");
  assertEquals(findBuyGame({ loser: "Kansas", winner: "Nobody" }, "2026-11-03", games), null);
  // A single loss is accepted even if the winner is spelled differently.
  assertEquals(
    findBuyGame({ loser: "Kansas", winner: "Kansas City" }, "2026-11-02", games.slice(0, 1))?.loser,
    "Kansas",
  );
});

Deno.test("unfinished games are ignored", () => {
  const live = { ...game("1", "2026-11-02", "Oklahoma", 40, "East Texas A&M", 45), is_final: false };
  assertEquals(findBuyGame({ loser: "Oklahoma", winner: "East Texas A&M" }, "2026-11-02", [live]), null);
});
