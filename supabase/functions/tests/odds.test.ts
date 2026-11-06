import { assertEquals } from "jsr:@std/assert@1";
import { type LeagueGame, lineForGame, matchOdds, nameScore, type OddsEvent, pickLine } from "../_shared/odds.ts";

Deno.test("Odds API names match NCAA names", () => {
  assertEquals(nameScore("Iowa State Cyclones", "Iowa St.") > 0, true);
  assertEquals(nameScore("USC Trojans", "Southern California") > 0, true);
  assertEquals(nameScore("Saint Mary's Gaels", "Saint Mary's (CA)") > 0, true);
  assertEquals(nameScore("Western Kentucky Hilltoppers", "Western Ky.") > 0, true);
  assertEquals(nameScore("Oklahoma Sooners", "Oklahoma") > 0, true);
  assertEquals(nameScore("Oklahoma State Cowboys", "Oklahoma") > 0, true); // prefix; the opponent decides
  assertEquals(
    nameScore("Oklahoma State Cowboys", "Oklahoma St.") > nameScore("Oklahoma State Cowboys", "Oklahoma"),
    true,
  );
  assertEquals(nameScore("Texas Longhorns", "Texas Tech"), 0);
});

const event = (
  id: string,
  home: string,
  away: string,
  time: string,
  books: OddsEvent["bookmakers"] = [],
): OddsEvent => ({
  id,
  commence_time: time,
  home_team: home,
  away_team: away,
  bookmakers: books,
});
const game = (id: string, home: string, away: string, time: string | null): LeagueGame => ({
  ncaa_game_id: id,
  home_team: home,
  away_team: away,
  start_time: time,
});

Deno.test("events match games by both names and start time", () => {
  const games = [
    game("g1", "Oklahoma", "East Texas A&M", "2026-11-03T01:00:00Z"),
    game("g2", "Oklahoma St.", "Tulsa", "2026-11-03T01:00:00Z"),
    game("g3", "Kansas", "UNC Greensboro", "2026-11-03T01:00:00Z"),
  ];
  const events = [
    event("e1", "Oklahoma Sooners", "East Texas A&M Lions", "2026-11-03T01:00:00Z"),
    event("e2", "Oklahoma State Cowboys", "Tulsa Golden Hurricane", "2026-11-03T01:10:00Z"),
    event("e3", "UNC Greensboro Spartans", "Kansas Jayhawks", "2026-11-03T01:00:00Z"), // listed the other way
    event("e4", "Duke Blue Devils", "Army Knights", "2026-11-03T01:00:00Z"), // not a league game
  ];
  const got = matchOdds(events, games).map((m) => `${m.game.ncaa_game_id}=${m.event.id}${m.swapped ? "*" : ""}`).sort();
  assertEquals(got, ["g1=e1", "g2=e2", "g3=e3*"]);
});

Deno.test("start times must be close", () => {
  const games = [game("g1", "Oklahoma", "Tulsa", "2026-11-03T01:00:00Z")];
  const events = [event("e1", "Oklahoma Sooners", "Tulsa Golden Hurricane", "2026-11-04T01:00:00Z")];
  assertEquals(matchOdds(events, games), []);
});

Deno.test("line comes from one preferred book and flips with home/away", () => {
  const e = event("e1", "Oklahoma Sooners", "East Texas A&M Lions", "2026-11-03T01:00:00Z", [
    {
      key: "bovada",
      title: "Bovada",
      markets: [{
        key: "h2h",
        outcomes: [{ name: "Oklahoma Sooners", price: -2000 }, { name: "East Texas A&M Lions", price: 1100 }],
      }],
    },
    {
      key: "draftkings",
      title: "DraftKings",
      markets: [
        {
          key: "h2h",
          outcomes: [{ name: "Oklahoma Sooners", price: -1800 }, { name: "East Texas A&M Lions", price: 1000 }],
        },
        {
          key: "spreads",
          outcomes: [
            { name: "Oklahoma Sooners", price: -110, point: -18.5 },
            { name: "East Texas A&M Lions", price: -110, point: 18.5 },
          ],
        },
      ],
    },
  ]);
  const line = pickLine(e)!;
  assertEquals(line, { homeMoneyline: -1800, awayMoneyline: 1000, homeSpread: -18.5, bookmaker: "DraftKings" });
  assertEquals(lineForGame(line, true), {
    homeMoneyline: 1000,
    awayMoneyline: -1800,
    homeSpread: 18.5,
    bookmaker: "DraftKings",
  });
  assertEquals(pickLine(event("e2", "A", "B", "2026-11-03T01:00:00Z")), null);
});
