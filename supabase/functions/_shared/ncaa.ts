// Client for the henrygd/ncaa-api proxy (https://github.com/henrygd/ncaa-api).
// The public instance is limited to ~5 requests/sec per IP; set NCAA_API_BASE to a
// self-hosted instance (it ships as a Docker image) if you run one on the home server.

export const DEFAULT_NCAA_API_BASE = "https://ncaa-api.henrygd.me";

type TeamApi = {
  names?: { short?: string };
  rank?: number | string | null;
  score?: number | string | null;
  winner?: boolean;
  conferences?: Array<{ conferenceSeo?: string | null }>;
};

type GameApi = {
  gameID?: string | number;
  startTimeEpoch?: number | string;
  contestClock?: string;
  currentPeriod?: string | number;
  gameState?: string;
  finalMessage?: string;
  home?: TeamApi;
  away?: TeamApi;
};

type ScoreboardResponse = {
  games?: Array<{ game?: GameApi } | GameApi>;
};

export type NormalizedTeam = {
  name: string | null;
  rank: number | null;
  score: number | null;
  winner: boolean;
  conferenceSeo: string | null;
};

export type NormalizedGame = {
  gameID: string | null;
  startTime: string | null; // ISO timestamp
  gameState: string | null;
  finalMessage: string | null;
  contestClock: string | null;
  currentPeriod: string | null;
  home: NormalizedTeam;
  away: NormalizedTeam;
  raw: unknown;
};

/** Normalize a school name the way the Sheets version did ("Michigan State" -> "Michigan St."). */
export function normalizeSchoolName(name: string | null | undefined): string {
  return (name ?? "").toString().trim().replace(/\s+/g, " ").replace(/\bState\b/g, "St.");
}

/** Looser key for matching AP poll names, which omit qualifiers like "(CA)" and add "(47)" vote counts. */
export function apMatchKey(name: string | null | undefined): string {
  return normalizeSchoolName((name ?? "").toString().replace(/\s*\(.*?\)\s*/g, " "));
}

function toNumberOrNull(value: unknown): number | null {
  if (value === "" || value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeTeam(team: TeamApi | undefined): NormalizedTeam {
  return {
    name: team?.names?.short ?? null,
    rank: toNumberOrNull(team?.rank),
    score: toNumberOrNull(team?.score),
    winner: team?.winner === true,
    conferenceSeo: team?.conferences?.[0]?.conferenceSeo?.toLowerCase() || null,
  };
}

export function normalizeGame(wrapper: { game?: GameApi } | GameApi): NormalizedGame {
  const game = ("game" in wrapper && wrapper.game ? wrapper.game : wrapper) as GameApi;
  const epoch = toNumberOrNull(game.startTimeEpoch);
  return {
    gameID: game.gameID != null && game.gameID !== "" ? String(game.gameID) : null,
    startTime: epoch ? new Date(epoch * 1000).toISOString() : null,
    gameState: game.gameState ?? null,
    finalMessage: game.finalMessage ?? null,
    contestClock: game.contestClock ?? null,
    currentPeriod: game.currentPeriod != null ? String(game.currentPeriod) : null,
    home: normalizeTeam(game.home),
    away: normalizeTeam(game.away),
    raw: game,
  };
}

/** Fetch every D1 men's game for a date given as YYYY-MM-DD. */
export async function fetchScoreboard(
  isoDate: string,
  baseUrl = DEFAULT_NCAA_API_BASE,
): Promise<NormalizedGame[]> {
  const path = isoDate.replaceAll("-", "/");
  const url = `${baseUrl}/scoreboard/basketball-men/d1/${path}/all-conf`;
  const res = await fetch(url, { headers: { accept: "application/json" } });

  // The API answers 404 for dates with no games.
  if (res.status === 404) {
    await res.body?.cancel();
    return [];
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`NCAA scoreboard request failed (${res.status}) for ${isoDate}`);
  }

  const data = (await res.json()) as ScoreboardResponse;
  return Array.isArray(data.games) ? data.games.map(normalizeGame) : [];
}

export type ApPollEntry = { school: string; rank: number };

/** Fetch the current AP Top 25. */
export async function fetchApPoll(baseUrl = DEFAULT_NCAA_API_BASE): Promise<ApPollEntry[]> {
  const res = await fetch(`${baseUrl}/rankings/basketball-men/d1/associated-press`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`AP poll request failed (${res.status})`);
  }
  const json = (await res.json()) as { data?: Array<Record<string, string>> };
  return parseApPoll(json);
}

export function parseApPoll(json: { data?: Array<Record<string, string>> }): ApPollEntry[] {
  const entries: ApPollEntry[] = [];
  for (const row of json.data ?? []) {
    const school = row.SCHOOL ?? row.TEAM ?? row.school ?? row.team;
    // Ties come through as e.g. "T-10".
    const rank = Number(String(row.RANK ?? row.rank ?? "").replace(/\D/g, ""));
    if (school && rank >= 1 && rank <= 25) entries.push({ school, rank });
  }
  return entries;
}
