"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { GameRow, LeagueData, ManagerRow, TeamRow } from "@/lib/data";
import {
  formatLine,
  formatPoints,
  formatSigned,
  formatTime,
  gameStatus,
  isLive,
  isPre,
  withRank,
} from "@/lib/format";

const REFRESH_MS = 60_000;

export type Tab = "managers" | "search" | "scores";
const TABS: Array<{ id: Tab; label: string }> = [
  { id: "managers", label: "Standings" },
  { id: "search", label: "Teams" },
  { id: "scores", label: "Games" },
];

/** Re-fetch server data every minute while the tab is visible, and on returning to it. */
function useAutoRefresh() {
  const router = useRouter();
  useEffect(() => {
    const refreshIfVisible = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    const id = setInterval(refreshIfVisible, REFRESH_MS);
    document.addEventListener("visibilitychange", refreshIfVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", refreshIfVisible);
    };
  }, [router]);
}

const byPoints = (a: TeamRow, b: TeamRow) =>
  b.total_points - a.total_points || a.team_name.localeCompare(b.team_name);

export function isTab(value: unknown): value is Tab {
  return TABS.some((t) => t.id === value);
}

/** Selected tab lives in ?tab= so it survives reloads and can be linked to. */
function useTabParam(): [Tab, (tab: Tab) => void] {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const current = params.get("tab");
  const tab: Tab = isTab(current) ? current : "managers";
  const setTab = (next: Tab) => {
    const query = new URLSearchParams(params);
    if (next === "managers") query.delete("tab");
    else query.set("tab", next);
    const qs = query.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
  return [tab, setTab];
}

export function League({ data }: { data: LeagueData }) {
  const [tab, setTab] = useTabParam();
  useAutoRefresh();

  const gamesById = useMemo(
    () => new Map(data.games.map((g) => [g.ncaa_game_id, g])),
    [data.games],
  );
  const teamsByManager = useMemo(() => {
    const map = new Map<number, TeamRow[]>();
    for (const t of data.teams)
      map.set(t.manager_id, [...(map.get(t.manager_id) ?? []), t]);
    for (const list of map.values()) list.sort(byPoints);
    return map;
  }, [data.teams]);
  const liveCount = data.games.filter(isLive).length;

  return (
    <main className="page">
      <header className="masthead">
        <h1>Fantasy Hoops</h1>
        <p className="season">{data.seasonLabel.replace("-", "–")} season</p>
        <p className="sync">
          {liveCount > 0 && (
            <span className="live-now">
              {liveCount} {liveCount === 1 ? "game" : "games"} live
            </span>
          )}
          {data.lastSynced && (
            <span>Scores updated {formatTime(data.lastSynced)}</span>
          )}
        </p>
      </header>

      <nav className="tabs" role="tablist" aria-label="Views">
        {TABS.map((t) => (
          <button
            key={t.id}
            id={`tab-${t.id}`}
            role="tab"
            type="button"
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            className="tab"
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <section
        id={`panel-${tab}`}
        role="tabpanel"
        aria-labelledby={`tab-${tab}`}
        className="panel"
      >
        {tab === "managers" && (
          <ManagersPanel
            managers={data.managers}
            teamsByManager={teamsByManager}
            gamesById={gamesById}
          />
        )}
        {tab === "search" && (
          <SearchPanel teams={data.teams} gamesById={gamesById} />
        )}
        {tab === "scores" && (
          <ScoresPanel games={data.games} teams={data.teams} />
        )}
      </section>
    </main>
  );
}

function Delta({ points }: { points: number }) {
  if (!points) return null;
  return (
    <span className={points > 0 ? "points-gain" : "points-loss"}>
      {formatSigned(points)}
    </span>
  );
}

function RankMovement({ manager }: { manager: ManagerRow }) {
  const moved = manager.previous_rank - manager.current_rank;
  if (!moved) return null;
  return (
    <span
      className={moved > 0 ? "rank-up" : "rank-down"}
      title={`Was #${manager.previous_rank} before today`}
    >
      <span aria-hidden="true">{moved > 0 ? "▲" : "▼"}</span>
      <span className="visually-hidden">{moved > 0 ? "up" : "down"}</span>
      {Math.abs(moved)}
    </span>
  );
}

type Slate = "won" | "lost" | "live" | "upcoming";
const SLATE_ORDER: Slate[] = ["won", "lost", "live", "upcoming"];
const SLATE_LABEL: Record<Slate, string> = {
  won: "won",
  lost: "lost",
  live: "live",
  upcoming: "still to play",
};

/** Where a team's game stands today, or null if it doesn't play. */
function slateOf(team: TeamRow, game: GameRow | undefined): Slate | null {
  if (!team.today_game_id || !game) return null;
  if (isPre(game)) return "upcoming";
  if (!game.is_final) return "live";
  return (team.today_team_score ?? 0) > (team.today_opponent_score ?? 0)
    ? "won"
    : "lost";
}

/** One mark per team playing today: won, lost, live, then still to play. */
function TonightStrip({
  teams,
  gamesById,
}: {
  teams: TeamRow[];
  gamesById: Map<string, GameRow>;
}) {
  const marks = teams
    .map((t) => ({
      team: t,
      slate: slateOf(
        t,
        t.today_game_id ? gamesById.get(t.today_game_id) : undefined,
      ),
    }))
    .filter((x): x is { team: TeamRow; slate: Slate } => x.slate !== null)
    .sort(
      (a, b) => SLATE_ORDER.indexOf(a.slate) - SLATE_ORDER.indexOf(b.slate),
    );
  if (!marks.length)
    return <span className="standing-meta">No games today</span>;

  const summary = SLATE_ORDER.map(
    (slate) => [slate, marks.filter((m) => m.slate === slate).length] as const,
  )
    .filter(([, n]) => n)
    .map(([slate, n]) => `${n} ${SLATE_LABEL[slate]}`)
    .join(", ");
  return (
    <span className="standing-meta tonight">
      <span className="tonight-marks" aria-hidden="true">
        {marks.map(({ team, slate }) => (
          <span
            key={team.team_name}
            className={`mark mark-${slate}`}
            title={`${team.team_name}: ${SLATE_LABEL[slate]}`}
          />
        ))}
      </span>
      <span className="tonight-summary">{summary}</span>
    </span>
  );
}

/** Points a manager can still add today: potential of every unfinished game. */
function atStake(teams: TeamRow[], gamesById: Map<string, GameRow>): number {
  return teams.reduce((sum, t) => {
    const game = t.today_game_id ? gamesById.get(t.today_game_id) : undefined;
    if (!game || game.is_final) return sum;
    return sum + Math.max(0, Number(t.today_potential_points) || 0);
  }, 0);
}

/** Standings: rank, tonight's slate, today's points (earned and still possible), and season total. */
function ManagersPanel({
  managers,
  teamsByManager,
  gamesById,
}: {
  managers: ManagerRow[];
  teamsByManager: Map<number, TeamRow[]>;
  gamesById: Map<string, GameRow>;
}) {
  if (!managers.length)
    return (
      <p className="empty-state">
        No rosters yet. Import the league to see standings.
      </p>
    );

  return (
    <>
      <div className="standings-head" aria-hidden="true">
        <span className="col-manager">Manager</span>
        <span className="col-num">Today</span>
        <span className="col-num">Points</span>
      </div>
      <ol className="standings">
        {managers.map((m) => {
          const total = Number(m.total_points);
          const teams = teamsByManager.get(m.manager_id) ?? [];
          const today = Number(m.today_points);
          const possible = atStake(teams, gamesById);
          return (
            <li key={m.manager_id} className="standing">
              <details>
                <summary>
                  <span className="standing-rank">{m.current_rank}</span>
                  <span className="standing-name">
                    {m.manager_name} <RankMovement manager={m} />
                    <TonightStrip teams={teams} gamesById={gamesById} />
                  </span>
                  <span className="col-num standing-today">
                    <span className="visually-hidden">Today </span>
                    <Delta points={today} />
                    {possible > 0 && (
                      <span
                        className="at-stake"
                        title={`Up to ${formatSigned(possible)} more if their remaining teams win`}
                      >
                        up to {formatSigned(possible)}
                      </span>
                    )}
                  </span>
                  <span className="col-num standing-points">
                    <span className="visually-hidden">Points </span>
                    {formatPoints(total)}
                  </span>
                </summary>
                <TeamsTable teams={teams} gamesById={gamesById} />
              </details>
            </li>
          );
        })}
      </ol>
    </>
  );
}

function SearchPanel({
  teams,
  gamesById,
}: {
  teams: TeamRow[];
  gamesById: Map<string, GameRow>;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const results = teams
    .filter(
      (t) =>
        !q ||
        t.team_name.toLowerCase().includes(q) ||
        t.manager_name.toLowerCase().includes(q),
    )
    .sort(byPoints);

  return (
    <>
      <label className="search">
        <span className="visually-hidden">Search teams</span>
        <input
          type="search"
          placeholder="Find a team or manager"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      {results.length ? (
        <TeamsTable teams={results} gamesById={gamesById} showManager />
      ) : (
        <p className="empty-state">
          No team or manager matches “{query.trim()}”.
        </p>
      )}
    </>
  );
}

function TeamsTable({
  teams,
  gamesById,
  showManager = false,
}: {
  teams: TeamRow[];
  gamesById: Map<string, GameRow>;
  showManager?: boolean;
}) {
  if (!teams.length)
    return <p className="empty-state">This manager has no teams yet.</p>;
  return (
    <div className="table-wrapper">
      <table className="teams-table">
        <thead>
          <tr>
            <th scope="col">Team</th>
            {showManager && <th scope="col">Manager</th>}
            <th scope="col">Today</th>
            <th scope="col" className="num">
              Points
            </th>
          </tr>
        </thead>
        <tbody>
          {teams.map((t) => (
            <tr key={t.team_name}>
              <td>
                <span className="team-name">
                  {withRank(t.team_name, t.ap_rank)}
                </span>
                {t.today_opponent && (
                  <span className="matchup">
                    {t.today_is_home ? "vs" : "at"}{" "}
                    {withRank(t.today_opponent, t.today_opponent_rank)}
                  </span>
                )}
              </td>
              {showManager && (
                <td className="manager-cell">{t.manager_name}</td>
              )}
              <td>
                <TodayCell
                  team={t}
                  game={
                    t.today_game_id ? gamesById.get(t.today_game_id) : undefined
                  }
                />
              </td>
              <td className="num">
                <strong>{formatPoints(t.total_points)}</strong>
                <Delta points={t.today_points} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TodayCell({
  team,
  game,
}: {
  team: TeamRow;
  game: GameRow | undefined;
}) {
  if (!team.today_game_id || !game)
    return <span className="muted">No game</span>;

  const potential = Number(team.today_potential_points) || 0;
  const potentialNote = !game.is_final && potential !== 0 && (
    <span className="potential" title="Points if they win">
      {formatSigned(potential)} with a win
    </span>
  );

  if (isPre(game)) {
    const line = teamLine(game, team.team_name);
    return (
      <span className="today">
        <span className="muted">
          {formatTime(game.start_time) || "Scheduled"}
        </span>
        {line && (
          <span className="odds" title={oddsTitle(game)}>
            {line}
          </span>
        )}
        {potentialNote}
      </span>
    );
  }

  const us = team.today_team_score ?? 0;
  const them = team.today_opponent_score ?? 0;
  const result = game.is_final ? (us > them ? "Won " : "Lost ") : "";
  return (
    <span className="today">
      <span className={game.is_final ? "score" : "score is-live"}>
        {result}
        {us}–{them}
      </span>
      {!game.is_final && <span className="muted">{gameStatus(game)}</span>}
      {potentialNote}
    </span>
  );
}

/** Today's games as score bugs (away on top, home below), live first. */
function ScoresPanel({ games, teams }: { games: GameRow[]; teams: TeamRow[] }) {
  const managerByTeam = useMemo(
    () => new Map(teams.map((t) => [t.team_name, t.manager_name])),
    [teams],
  );
  if (!games.length)
    return <p className="empty-state">No league teams play today.</p>;

  const groups = [
    { title: "Live", live: true, games: games.filter(isLive) },
    { title: "Coming up", live: false, games: games.filter((g) => isPre(g)) },
    {
      title: "Final",
      live: false,
      games: games.filter((g) => !isLive(g) && !isPre(g)),
    },
  ].filter((group) => group.games.length);

  return (
    <>
      {groups.map((group) => (
        <section
          key={group.title}
          className={`game-group${group.live ? " is-live" : ""}`}
          aria-label={group.title}
        >
          <h2>{group.title}</h2>
          <ul className="games">
            {group.games.map((g) => (
              <li
                key={g.ncaa_game_id}
                className={`game${isLive(g) ? " is-live" : ""}`}
              >
                <GameSide
                  game={g}
                  home={false}
                  manager={managerByTeam.get(g.away_team)}
                />
                <GameSide
                  game={g}
                  home
                  manager={managerByTeam.get(g.home_team)}
                />
                <p className="game-status">{gameStatus(g)}</p>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

function GameSide({
  game,
  home,
  manager,
}: {
  game: GameRow;
  home: boolean;
  manager: string | undefined;
}) {
  const name = home ? game.home_team : game.away_team;
  const score = home ? game.home_score : game.away_score;
  const lost = game.is_final && !(home ? game.home_winner : game.away_winner);
  const line = isPre(game) ? teamLine(game, name) : "";
  return (
    <div className={`side${lost ? " lost" : ""}`}>
      <span className="side-team">
        <span className="side-name">
          {withRank(name, home ? game.home_rank : game.away_rank)}
        </span>
        {manager && <span className="side-manager">{manager}</span>}
      </span>
      {isPre(game) ? (
        <span className="side-line" title={line ? oddsTitle(game) : undefined}>
          {line}
        </span>
      ) : (
        <span className="side-score">{score ?? 0}</span>
      )}
    </div>
  );
}

/** A team's spread and moneyline in a game, e.g. "-18.5 (-1800)"; "" if there's no line. */
function teamLine(game: GameRow, teamName: string): string {
  const home = game.home_team === teamName;
  const spread =
    game.home_spread == null
      ? null
      : home
        ? Number(game.home_spread)
        : -Number(game.home_spread);
  return formatLine(spread, home ? game.home_odds : game.away_odds);
}

function oddsTitle(game: GameRow): string {
  return `Spread (moneyline)${game.odds_bookmaker ? ` from ${game.odds_bookmaker}` : ""}`;
}
