// deno test supabase/functions/tests/
import { assertEquals } from "jsr:@std/assert@1";
import { addDays, dateRange, gameDay, isIsoDate } from "../_shared/dates.ts";
import { apMatchKey, normalizeGame, normalizeSchoolName, parseApPoll } from "../_shared/ncaa.ts";
import { calculateGamePoints, isGameFinal, scoreGame, type Tier, unknownConferences } from "../_shared/scoring.ts";

const tiers = new Map<string, Tier>([
  ["big-ten", "highMajor"],
  ["sec", "highMajor"],
  ["wcc", "highMid"],
  ["mvc", "trueMid"],
  ["swac", "lowMajor"],
]);

type Side = { name: string; conf?: string; score?: number; rank?: string; winner?: boolean };

/** Builds a raw NCAA API game in the same shape the scoreboard returns. */
function rawGame(home: Side, away: Side, overrides: Record<string, unknown> = {}) {
  const team = (s: Side) => ({
    names: { short: s.name },
    score: s.score === undefined ? "" : String(s.score),
    rank: s.rank ?? "",
    winner: s.winner ?? false,
    conferences: [{ conferenceSeo: s.conf ?? "" }],
  });
  return {
    game: {
      gameID: "1",
      gameState: "final",
      currentPeriod: "FINAL",
      finalMessage: "FINAL",
      contestClock: "0:00",
      startTimeEpoch: "1771088400",
      home: team(home),
      away: team(away),
      ...overrides,
    },
  };
}

const win = (name: string, conf: string, extra: Partial<Side> = {}) => ({
  name,
  conf,
  score: 80,
  winner: true,
  ...extra,
});
const loss = (name: string, conf: string, extra: Partial<Side> = {}) => ({ name, conf, score: 70, ...extra });
const g = (home: Side, away: Side, o?: Record<string, unknown>) => normalizeGame(rawGame(home, away, o));

Deno.test("in-conference win: tier points, road worth more", () => {
  assertEquals(calculateGamePoints(g(win("Purdue", "big-ten"), loss("Iowa", "big-ten")), true, tiers), 3.5);
  assertEquals(calculateGamePoints(g(loss("Purdue", "big-ten"), win("Iowa", "big-ten")), false, tiers), 5);
  assertEquals(calculateGamePoints(g(win("Drake", "mvc"), loss("UNI", "mvc")), true, tiers), 1.5);
});

Deno.test("non-conference win: 2 per tier gap, 0 for beating a lower tier", () => {
  assertEquals(calculateGamePoints(g(win("Gonzaga", "wcc"), loss("Kentucky", "sec")), true, tiers), 4); // up one tier
  assertEquals(calculateGamePoints(g(win("Kentucky", "sec"), loss("Iowa", "big-ten")), true, tiers), 2); // peer
  assertEquals(calculateGamePoints(g(win("Kentucky", "sec"), loss("Drake", "mvc")), true, tiers), 0); // lower tier
  assertEquals(calculateGamePoints(g(win("Alcorn", "swac"), loss("Kentucky", "sec")), true, tiers), 8); // up three
});

Deno.test("ranked loser bonus: +5 for top 10, +2.5 for 11-25", () => {
  assertEquals(
    calculateGamePoints(g(win("Iowa", "big-ten"), loss("Purdue", "big-ten", { rank: "3" })), true, tiers),
    8.5,
  );
  assertEquals(
    calculateGamePoints(g(win("Iowa", "big-ten"), loss("Purdue", "big-ten", { rank: "18" })), true, tiers),
    6,
  );
  assertEquals(
    calculateGamePoints(g(win("Iowa", "big-ten"), loss("Purdue", "big-ten", { rank: "" })), true, tiers),
    3.5,
  );
});

Deno.test("non-D1: -4 to a rostered loser, and to the winner's points", () => {
  const game = g(win("Div II U", "gulf-south"), loss("Kentucky", "sec"));
  const roster = (n: string | null) => (n === "Kentucky" ? "Kentucky" : undefined);
  assertEquals(scoreGame(game, roster, tiers), [
    { ncaa_game_id: "1", team_name: "Kentucky", points: -4, reason: "loss_to_non_d1" },
  ]);
  // Winner side: beating a high major from "tier -1" is (3 - -1 + 1) * 2 - 4.
  assertEquals(calculateGamePoints(game, true, tiers), 6);
});

Deno.test("only rostered teams get ledger entries; ordinary losses earn nothing", () => {
  const game = g(win("Purdue", "big-ten"), loss("Iowa", "big-ten"));
  assertEquals(scoreGame(game, (n) => (n === "Iowa" ? "Iowa" : undefined), tiers), []);
  assertEquals(scoreGame(game, (n) => (n === "Purdue" ? "Purdue" : undefined), tiers), [
    { ncaa_game_id: "1", team_name: "Purdue", points: 3.5, reason: "win" },
  ]);
});

Deno.test("isGameFinal: overtime finals count (the Sheets version skipped them)", () => {
  assertEquals(isGameFinal(g(win("A", "sec"), loss("B", "sec"), { currentPeriod: "FINAL - OT" })), true);
  assertEquals(isGameFinal(g(win("A", "sec"), loss("B", "sec"), { currentPeriod: "FINAL - 3OT" })), true);
});

Deno.test("isGameFinal: live, tied, or inconsistent games are not final", () => {
  const live = { gameState: "live", currentPeriod: "2ND", finalMessage: "", contestClock: "4:12" };
  assertEquals(
    isGameFinal(g({ name: "A", conf: "sec", score: 50 }, { name: "B", conf: "sec", score: 40 }, live)),
    false,
  );
  assertEquals(isGameFinal(g({ name: "A", score: 70, winner: true }, { name: "B", score: 70 })), false);
  assertEquals(isGameFinal(g({ name: "A", score: 60, winner: true }, { name: "B", score: 70 })), false);
  assertEquals(isGameFinal(g({ name: "A", score: 80 }, { name: "B", score: 70 })), false); // no winner flag
});

Deno.test("unknownConferences flags conferences missing a tier", () => {
  const games = [g(win("Austin Peay", "uac-"), loss("Kentucky", "sec"))];
  assertEquals(unknownConferences(games, tiers), ["uac-"]);
});

Deno.test("name normalization matches scoreboard and AP poll spellings", () => {
  assertEquals(normalizeSchoolName("Michigan State"), "Michigan St.");
  assertEquals(normalizeSchoolName(" Iowa  State "), "Iowa St.");
  assertEquals(apMatchKey("Florida (47)"), apMatchKey("Florida"));
  assertEquals(apMatchKey("Saint Mary's (CA)"), apMatchKey("Saint Mary's"));
  assertEquals(apMatchKey("Michigan State"), apMatchKey("Michigan St."));
});

Deno.test("parseApPoll handles ties and drops junk rows", () => {
  assertEquals(
    parseApPoll({
      data: [{ RANK: "1", SCHOOL: "Florida (47)" }, { RANK: "T-10", SCHOOL: "Duke" }, { RANK: "", SCHOOL: "X" }],
    }),
    [{ school: "Florida (47)", rank: 1 }, { school: "Duke", rank: 10 }],
  );
});

Deno.test("gameDay uses Central time with a 3am rollover, regardless of server TZ", () => {
  // 2026-02-15 07:30Z = 1:30am CST -> still the 14th
  assertEquals(gameDay(new Date("2026-02-15T07:30:00Z")), "2026-02-14");
  // 2026-02-15 09:30Z = 3:30am CST -> the 15th
  assertEquals(gameDay(new Date("2026-02-15T09:30:00Z")), "2026-02-15");
  // during CDT (UTC-5): 2026-03-20 07:30Z = 2:30am CDT -> the 19th
  assertEquals(gameDay(new Date("2026-03-20T07:30:00Z")), "2026-03-19");
});

Deno.test("date helpers", () => {
  assertEquals(isIsoDate("2026-02-30"), false);
  assertEquals(isIsoDate("2026/02/14"), false);
  assertEquals(isIsoDate("2026-02-14"), true);
  assertEquals(addDays("2026-02-28", 1), "2026-03-01");
  assertEquals(dateRange("2025-12-30", "2026-01-02"), ["2025-12-30", "2025-12-31", "2026-01-01", "2026-01-02"]);
});
