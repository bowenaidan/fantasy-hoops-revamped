// Server-side data access. Runs only in server components, so the Supabase URL
// and anon key never reach the browser and Supabase itself doesn't need to be
// exposed outside the home network: only the Next.js app does.
import { createClient } from '@supabase/supabase-js';

export type TeamRow = {
  team_name: string;
  manager_id: number;
  manager_name: string;
  ap_rank: number | null;
  total_points: number;
  today_points: number;
  today_game_id: string | null;
  today_is_home: boolean | null;
  today_opponent: string | null;
  today_opponent_rank: number | null;
  today_potential_points: number | null;
  today_team_score: number | null;
  today_opponent_score: number | null;
  today_game_state: string | null;
  today_start_time: string | null;
};

export type ManagerRow = {
  manager_id: number;
  manager_name: string;
  total_points: number;
  today_points: number;
  team_count: number;
  current_rank: number;
  previous_rank: number;
};

export type GameRow = {
  ncaa_game_id: string;
  start_time: string | null;
  game_state: string | null;
  current_period: string | null;
  contest_clock: string | null;
  is_final: boolean;
  home_team: string;
  home_rank: number | null;
  home_score: number | null;
  home_winner: boolean;
  away_team: string;
  away_rank: number | null;
  away_score: number | null;
  away_winner: boolean;
  updated_at: string;
};

export type LeagueData = {
  seasonLabel: string;
  managers: ManagerRow[];
  teams: TeamRow[];
  games: GameRow[];
  lastSynced: string | null;
};

type Season = { id: number; label: string; start_date: string; end_date: string };

// Same rule as public.current_game_day(): Central time, 3am rollover.
function gameDay(now = new Date()): string {
  const shifted = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(shifted);
}

/** The season containing today, otherwise the most recent one that has started. */
function pickSeason(seasons: Season[], today: string): Season | undefined {
  const sorted = [...seasons].sort((a, b) => b.start_date.localeCompare(a.start_date));
  return sorted.find((s) => s.start_date <= today && today <= s.end_date) ?? sorted.find((s) => s.start_date <= today);
}

function client() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY must be set (see .env.example).');
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function getLeagueData(): Promise<LeagueData | null> {
  const db = client();

  const { data: seasons, error: seasonErr } = await db.from('seasons').select('id, label, start_date, end_date');
  if (seasonErr) throw new Error(`Loading seasons: ${seasonErr.message}`);
  const season = pickSeason(seasons ?? [], gameDay());
  if (!season) return null;

  const [managers, teams, games] = await Promise.all([
    db.from('manager_standings').select('*').eq('season_id', season.id).order('current_rank').order('manager_name'),
    db.from('team_standings').select('*').eq('season_id', season.id),
    db.from('todays_games').select('*').order('start_time', { nullsFirst: false }),
  ]);
  for (const [name, res] of [['manager standings', managers], ['team standings', teams], ['games', games]] as const) {
    if (res.error) throw new Error(`Loading ${name}: ${res.error.message}`);
  }

  const gameRows = (games.data ?? []) as GameRow[];
  return {
    seasonLabel: season.label,
    managers: (managers.data ?? []) as ManagerRow[],
    teams: (teams.data ?? []) as TeamRow[],
    games: gameRows,
    lastSynced: gameRows.reduce<string | null>((max, g) => (!max || g.updated_at > max ? g.updated_at : max), null),
  };
}
