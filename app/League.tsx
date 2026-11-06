'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import type { GameRow, LeagueData, ManagerRow, TeamRow } from '@/lib/data';
import { formatLine, formatPoints, formatSigned, formatTime, gameStatus, isPre, withRank } from '@/lib/format';

const REFRESH_MS = 60_000;

export type Tab = 'managers' | 'search' | 'scores';
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'managers', label: 'By manager' },
  { id: 'search', label: 'Search teams' },
  { id: 'scores', label: 'Live scores' },
];

/** Re-fetch server data every minute while the tab is visible, and on returning to it. */
function useAutoRefresh() {
  const router = useRouter();
  useEffect(() => {
    const refreshIfVisible = () => {
      if (document.visibilityState === 'visible') router.refresh();
    };
    const id = setInterval(refreshIfVisible, REFRESH_MS);
    document.addEventListener('visibilitychange', refreshIfVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', refreshIfVisible);
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
  const current = params.get('tab');
  const tab: Tab = isTab(current) ? current : 'managers';
  const setTab = (next: Tab) => {
    const query = new URLSearchParams(params);
    if (next === 'managers') query.delete('tab');
    else query.set('tab', next);
    const qs = query.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
  return [tab, setTab];
}

export function League({ data }: { data: LeagueData }) {
  const [tab, setTab] = useTabParam();
  useAutoRefresh();

  const gamesById = useMemo(() => new Map(data.games.map((g) => [g.ncaa_game_id, g])), [data.games]);
  const teamsByManager = useMemo(() => {
    const map = new Map<number, TeamRow[]>();
    for (const t of data.teams) map.set(t.manager_id, [...(map.get(t.manager_id) ?? []), t]);
    for (const list of map.values()) list.sort(byPoints);
    return map;
  }, [data.teams]);

  return (
    <main className="page">
      <header>
        <h1>Fantasy Hoops</h1>
        <p className="description">
          {data.seasonLabel} season
          {data.lastSynced && <> · Scores updated {formatTime(data.lastSynced)}</>}
        </p>
      </header>

      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            id={`tab-${t.id}`}
            role="tab"
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            className={`tab-button${tab === t.id ? ' active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <section id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {tab === 'managers' && (
          <ManagersPanel managers={data.managers} teamsByManager={teamsByManager} gamesById={gamesById} />
        )}
        {tab === 'search' && <SearchPanel teams={data.teams} gamesById={gamesById} />}
        {tab === 'scores' && <ScoresPanel games={data.games} teams={data.teams} />}
      </section>
    </main>
  );
}

function Delta({ points }: { points: number }) {
  if (!points) return null;
  return <span className={points > 0 ? 'points-gain' : 'points-loss'}>{formatSigned(points)}</span>;
}

function RankMovement({ manager }: { manager: ManagerRow }) {
  const moved = manager.previous_rank - manager.current_rank;
  if (!moved) return null;
  return (
    <span className={moved > 0 ? 'rank-up' : 'rank-down'} title={`Was #${manager.previous_rank} before today`}>
      {moved > 0 ? '▲' : '▼'}
      {Math.abs(moved)}
    </span>
  );
}

function ManagersPanel({
  managers,
  teamsByManager,
  gamesById,
}: {
  managers: ManagerRow[];
  teamsByManager: Map<number, TeamRow[]>;
  gamesById: Map<string, GameRow>;
}) {
  if (!managers.length) return <p className="empty-state">No rosters have been set up for this season.</p>;
  return (
    <div className="manager-list">
      {managers.map((m) => (
        <details key={m.manager_id} className="manager-dropdown">
          <summary className="manager-summary">
            <span className="manager-rank">#{m.current_rank}</span>
            <span className="manager-name">
              {m.manager_name} <RankMovement manager={m} />
            </span>
            <span className="manager-points">
              <Delta points={m.today_points} /> <strong>{formatPoints(m.total_points)}</strong> pts
            </span>
          </summary>
          <TeamsTable teams={teamsByManager.get(m.manager_id) ?? []} gamesById={gamesById} />
        </details>
      ))}
    </div>
  );
}

function SearchPanel({ teams, gamesById }: { teams: TeamRow[]; gamesById: Map<string, GameRow> }) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const results = teams
    .filter((t) => !q || t.team_name.toLowerCase().includes(q) || t.manager_name.toLowerCase().includes(q))
    .sort(byPoints);

  return (
    <>
      <input
        className="search-input"
        type="search"
        placeholder="Search by team or manager"
        aria-label="Search teams"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {results.length ? (
        <TeamsTable teams={results} gamesById={gamesById} showManager />
      ) : (
        <p className="empty-state">No teams match your search.</p>
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
  if (!teams.length) return <p className="empty-state">No teams assigned to this manager.</p>;
  return (
    <div className="table-wrapper">
      <table className="teams-table">
        <thead>
          <tr>
            <th>Team</th>
            {showManager && <th>Manager</th>}
            <th>Today</th>
            <th className="num">Points</th>
          </tr>
        </thead>
        <tbody>
          {teams.map((t) => (
            <tr key={t.team_name}>
              <td>
                <strong>{withRank(t.team_name, t.ap_rank)}</strong>
                {t.today_opponent && (
                  <span className="matchup">
                    {t.today_is_home ? 'vs' : '@'} {withRank(t.today_opponent, t.today_opponent_rank)}
                  </span>
                )}
              </td>
              {showManager && <td>{t.manager_name}</td>}
              <td>
                <TodayCell team={t} game={t.today_game_id ? gamesById.get(t.today_game_id) : undefined} />
              </td>
              <td className="num">
                <strong>{formatPoints(t.total_points)}</strong> <Delta points={t.today_points} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TodayCell({ team, game }: { team: TeamRow; game: GameRow | undefined }) {
  if (!team.today_game_id || !game) return <span className="muted">No game</span>;

  const potential = Number(team.today_potential_points) || 0;
  const potentialNote = !game.is_final && potential !== 0 && (
    <span className="potential" title="Points if they win">
      {formatSigned(potential)} if W
    </span>
  );

  if (isPre(game)) {
    const line = teamLine(game, team.team_name);
    return (
      <>
        <span className="muted">{formatTime(game.start_time) || 'Scheduled'}</span>{' '}
        {line && (
          <span className="odds" title={oddsTitle(game)}>
            {line}
          </span>
        )}{' '}
        {potentialNote}
      </>
    );
  }

  const us = team.today_team_score ?? 0;
  const them = team.today_opponent_score ?? 0;
  const prefix = game.is_final ? (us > them ? 'W ' : 'L ') : '';
  return (
    <>
      <span className={game.is_final ? '' : 'live-indicator'}>
        {prefix}
        {us}–{them}
      </span>{' '}
      <span className="muted">{gameStatus(game)}</span> {potentialNote}
    </>
  );
}

function ScoresPanel({ games, teams }: { games: GameRow[]; teams: TeamRow[] }) {
  const managerByTeam = useMemo(() => new Map(teams.map((t) => [t.team_name, t.manager_name])), [teams]);
  if (!games.length) return <p className="empty-state">No games today.</p>;

  const side = (g: GameRow, home: boolean) => {
    const name = home ? g.home_team : g.away_team;
    const winner = home ? g.home_winner : g.away_winner;
    const line = teamLine(g, name);
    return (
      <>
        <strong className={g.is_final && !winner ? 'muted' : ''}>
          {withRank(name, home ? g.home_rank : g.away_rank)}
        </strong>
        {managerByTeam.has(name) && <span className="team-manager">{managerByTeam.get(name)}</span>}
        {line && (
          <span className="odds odds-block" title={oddsTitle(g)}>
            {line}
          </span>
        )}
      </>
    );
  };

  return (
    <div className="table-wrapper">
      <table className="scores-table">
        <thead>
          <tr>
            <th>Home</th>
            <th className="center">Score</th>
            <th className="right">Away</th>
          </tr>
        </thead>
        <tbody>
          {games.map((g) => (
            <tr key={g.ncaa_game_id}>
              <td>{side(g, true)}</td>
              <td className="center">
                <strong className={g.game_state === 'live' ? 'live-indicator' : ''}>
                  {isPre(g) ? '–' : `${g.home_score ?? 0} – ${g.away_score ?? 0}`}
                </strong>
                <span className="muted status">{gameStatus(g)}</span>
              </td>
              <td className="right">{side(g, false)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A team's spread and moneyline in a game, e.g. "-18.5 (-1800)"; "" if there's no line. */
function teamLine(game: GameRow, teamName: string): string {
  const home = game.home_team === teamName;
  const spread = game.home_spread == null ? null : home ? Number(game.home_spread) : -Number(game.home_spread);
  return formatLine(spread, home ? game.home_odds : game.away_odds);
}

function oddsTitle(game: GameRow): string {
  return `Spread (moneyline)${game.odds_bookmaker ? ` from ${game.odds_bookmaker}` : ''}; last line before tip-off`;
}
