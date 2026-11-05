-- Fantasy Hoops core schema.
--
-- Replaces the old standalone tables (teams_daily, manager_scores, game_history,
-- live_scores, buy_game_losses) with a linked model:
--
--   seasons ─┬─ rosters (team -> manager per season) ─┬─ team_game_points (scoring ledger)
--            │                                         └─ point_adjustments (buy-game losses, manual fixes)
--   managers ┘
--   teams, conference_tiers, games
--
-- Scores are never "settled" into a running total like the Sheets version did.
-- Every point comes from a ledger row keyed by (NCAA game id, team), so re-running
-- a sync for any date is idempotent and season totals are always just a SUM.
--
-- Writes go through the service role (edge functions). anon/authenticated get
-- read-only access via RLS so the public standings page can query directly.

------------------------------------------------------------------------------
-- League configuration
------------------------------------------------------------------------------

create table public.seasons (
  id          bigint generated always as identity primary key,
  label       text not null unique,                 -- e.g. '2026-27'
  start_date  date not null,
  end_date    date not null,
  constraint seasons_dates_ordered check (end_date >= start_date),
  -- a calendar date can belong to at most one season
  constraint seasons_no_overlap exclude using gist (daterange(start_date, end_date, '[]') with &&)
);

create table public.managers (
  id    bigint generated always as identity primary key,
  name  text not null unique
);

-- Conference tier used by the scoring rules. Kept in the database (not code) so a
-- realignment can be fixed with an UPDATE instead of a redeploy. A conference that
-- is missing from this table is treated as non-D1 (the -4 rule), so keep it current.
create table public.conference_tiers (
  conference_seo  text primary key,                 -- NCAA API conferenceSeo, e.g. 'big-ten'
  tier            text not null check (tier in ('highMajor', 'highMid', 'trueMid', 'lowMajor'))
);

insert into public.conference_tiers (conference_seo, tier) values
  ('acc', 'highMajor'), ('big-12', 'highMajor'), ('big-ten', 'highMajor'), ('sec', 'highMajor'), ('big-east', 'highMajor'),
  ('mountain-west', 'highMid'), ('atlantic-10', 'highMid'), ('wcc', 'highMid'), ('american', 'highMid'),
  ('mvc', 'trueMid'), ('cusa', 'trueMid'), ('ivy-league', 'trueMid'), ('big-west', 'trueMid'), ('socon', 'trueMid'),
  ('caa', 'trueMid'), ('sun-belt', 'trueMid'), ('mac', 'trueMid'),
  ('wac', 'lowMajor'), ('big-south', 'lowMajor'), ('big-sky', 'lowMajor'), ('southland', 'lowMajor'), ('horizon', 'lowMajor'),
  ('summit-league', 'lowMajor'), ('maac', 'lowMajor'), ('asun', 'lowMajor'), ('ovc', 'lowMajor'), ('patriot', 'lowMajor'),
  ('america-east', 'lowMajor'), ('swac', 'lowMajor'), ('meac', 'lowMajor'), ('nec', 'lowMajor');

-- Teams are keyed by the NCAA scoreboard short name (e.g. 'Michigan St.', "Saint Mary's (CA)").
create table public.teams (
  name            text primary key,
  conference_seo  text,                             -- refreshed from the scoreboard on each sync
  ap_rank         smallint check (ap_rank between 1 and 25),
  updated_at      timestamptz not null default now()
);

create table public.rosters (
  season_id   bigint not null references public.seasons (id) on delete cascade,
  team_name   text   not null references public.teams (name) on update cascade,
  manager_id  bigint not null references public.managers (id),
  primary key (season_id, team_name)
);
create index rosters_manager_idx on public.rosters (manager_id);

------------------------------------------------------------------------------
-- Game data and scoring
------------------------------------------------------------------------------

-- Only games involving a rostered team are stored. raw keeps the upstream payload
-- so games can be re-scored later without refetching.
create table public.games (
  ncaa_game_id           text primary key,
  game_date              date not null,             -- league game day (scoreboard date)
  start_time             timestamptz,
  game_state             text,
  current_period         text,
  contest_clock          text,
  final_message          text,
  is_final               boolean not null default false,

  home_team              text not null,
  home_score             smallint,
  home_rank              smallint,
  home_conference        text,
  home_winner            boolean not null default false,
  home_potential_points  numeric(5, 2),             -- points the home team earns if it wins
  home_odds              numeric,

  away_team              text not null,
  away_score             smallint,
  away_rank              smallint,
  away_conference        text,
  away_winner            boolean not null default false,
  away_potential_points  numeric(5, 2),
  away_odds              numeric,

  raw                    jsonb not null,
  updated_at             timestamptz not null default now()
);
create index games_game_date_idx on public.games (game_date);

-- Scoring ledger: one row per rostered team per final game that earned/lost points.
create table public.team_game_points (
  season_id     bigint  not null,
  team_name     text    not null,
  ncaa_game_id  text    not null references public.games (ncaa_game_id) on delete cascade,
  game_date     date    not null,
  points        numeric(5, 2) not null,             -- half points (3.5, 2.5, ...) are common
  reason        text    not null check (reason in ('win', 'loss_to_non_d1')),
  computed_at   timestamptz not null default now(),
  primary key (ncaa_game_id, team_name),
  foreign key (season_id, team_name) references public.rosters (season_id, team_name) on delete cascade
);
create index team_game_points_team_idx on public.team_game_points (season_id, team_name);
create index team_game_points_date_idx on public.team_game_points (game_date);

-- Points that don't come from the scoreboard: buy-game losses (previously the
-- BUY_GAME_LOSSES sheet) and manual commissioner corrections.
create table public.point_adjustments (
  id           bigint generated always as identity primary key,
  season_id    bigint not null,
  team_name    text   not null,
  points       numeric(5, 2) not null,
  kind         text   not null default 'manual' check (kind in ('buy_game_loss', 'manual')),
  game_date    date,
  note         text,
  source_url   text,                                -- e.g. the post that flagged a buy-game loss
  created_at   timestamptz not null default now(),
  foreign key (season_id, team_name) references public.rosters (season_id, team_name) on delete cascade
);
create index point_adjustments_team_idx on public.point_adjustments (season_id, team_name);
-- lets the RSS importer insert idempotently
create unique index point_adjustments_source_url_key on public.point_adjustments (source_url) where source_url is not null;

------------------------------------------------------------------------------
-- Functions
------------------------------------------------------------------------------

-- The league "game day": Central time with a 3am rollover, so late West Coast games
-- count toward the day they tipped off. Matches the Apps Script version and does not
-- depend on the server's timezone. Keep in sync with gameDay() in _shared/dates.ts.
create function public.current_game_day()
returns date
language sql
stable
set search_path = ''
as $$
  select ((now() at time zone 'America/Chicago') - interval '3 hours')::date
$$;

-- Atomically replace everything synced for one game day. Called by the sync-scores
-- edge function with the games and ledger rows it computed.
create function public.apply_day_sync(
  p_season_id  bigint,
  p_game_date  date,
  p_games      jsonb,
  p_points     jsonb
)
returns void
language plpgsql
set search_path = ''
as $$
begin
  insert into public.games as g (
    ncaa_game_id, game_date, start_time, game_state, current_period, contest_clock, final_message, is_final,
    home_team, home_score, home_rank, home_conference, home_winner, home_potential_points,
    away_team, away_score, away_rank, away_conference, away_winner, away_potential_points,
    raw, updated_at
  )
  select
    x.ncaa_game_id, p_game_date, x.start_time, x.game_state, x.current_period, x.contest_clock, x.final_message, x.is_final,
    x.home_team, x.home_score, x.home_rank, x.home_conference, x.home_winner, x.home_potential_points,
    x.away_team, x.away_score, x.away_rank, x.away_conference, x.away_winner, x.away_potential_points,
    x.raw, now()
  from jsonb_to_recordset(p_games) as x (
    ncaa_game_id text, start_time timestamptz, game_state text, current_period text, contest_clock text,
    final_message text, is_final boolean,
    home_team text, home_score smallint, home_rank smallint, home_conference text, home_winner boolean,
    home_potential_points numeric,
    away_team text, away_score smallint, away_rank smallint, away_conference text, away_winner boolean,
    away_potential_points numeric,
    raw jsonb
  )
  on conflict (ncaa_game_id) do update set
    game_date = excluded.game_date,
    start_time = excluded.start_time,
    game_state = excluded.game_state,
    current_period = excluded.current_period,
    contest_clock = excluded.contest_clock,
    final_message = excluded.final_message,
    is_final = excluded.is_final,
    home_team = excluded.home_team,
    home_score = excluded.home_score,
    home_rank = excluded.home_rank,
    home_conference = excluded.home_conference,
    home_winner = excluded.home_winner,
    home_potential_points = excluded.home_potential_points,
    away_team = excluded.away_team,
    away_score = excluded.away_score,
    away_rank = excluded.away_rank,
    away_conference = excluded.away_conference,
    away_winner = excluded.away_winner,
    away_potential_points = excluded.away_potential_points,
    raw = excluded.raw,
    updated_at = now();

  -- Games that dropped off this day's scoreboard (postponed, or a team left the
  -- roster). Cascades to their ledger rows.
  delete from public.games g
  where g.game_date = p_game_date
    and not exists (
      select 1 from jsonb_array_elements(p_games) e where e ->> 'ncaa_game_id' = g.ncaa_game_id
    );

  delete from public.team_game_points t
  where t.season_id = p_season_id and t.game_date = p_game_date;

  insert into public.team_game_points (season_id, team_name, ncaa_game_id, game_date, points, reason)
  select p_season_id, x.team_name, x.ncaa_game_id, p_game_date, x.points, x.reason
  from jsonb_to_recordset(p_points) as x (team_name text, ncaa_game_id text, points numeric, reason text);

  -- Keep each rostered team's conference current (realignment happens).
  update public.teams t
  set conference_seo = c.conference_seo, updated_at = now()
  from (
    select distinct on (team) team, conference_seo
    from (
      select x.home_team as team, x.home_conference as conference_seo
      from jsonb_to_recordset(p_games) as x (home_team text, home_conference text)
      union all
      select x.away_team, x.away_conference
      from jsonb_to_recordset(p_games) as x (away_team text, away_conference text)
    ) s
    where conference_seo is not null
  ) c
  where t.name = c.team and t.conference_seo is distinct from c.conference_seo;
end;
$$;

-- Set every team's AP rank in one statement; teams not in p_ranks become unranked.
create function public.apply_ap_rankings(p_ranks jsonb)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  changed integer;
begin
  update public.teams t
  set ap_rank = r.ap_rank, updated_at = now()
  from (
    select t2.name, x.ap_rank
    from public.teams t2
    left join jsonb_to_recordset(p_ranks) as x (team_name text, ap_rank smallint) on x.team_name = t2.name
  ) r
  where t.name = r.name and t.ap_rank is distinct from r.ap_rank;
  get diagnostics changed = row_count;
  return changed;
end;
$$;

-- Supabase grants EXECUTE on new functions to anon/authenticated by default, which
-- would expose these through /rest/v1/rpc. Only the service role may write.
revoke execute on function public.apply_day_sync(bigint, date, jsonb, jsonb) from public, anon, authenticated;
revoke execute on function public.apply_ap_rankings(jsonb) from public, anon, authenticated;
grant execute on function public.apply_day_sync(bigint, date, jsonb, jsonb) to service_role;
grant execute on function public.apply_ap_rankings(jsonb) to service_role;

------------------------------------------------------------------------------
-- Read models for the web app
------------------------------------------------------------------------------

-- One row per rostered team: season total, today's points, and today's matchup.
create view public.team_standings
with (security_invoker = true)
as
select
  r.season_id,
  s.label                                         as season_label,
  r.team_name,
  r.manager_id,
  m.name                                          as manager_name,
  t.ap_rank,
  t.conference_seo,
  coalesce(p.game_points, 0) + coalesce(a.adjustment_points, 0) as total_points,
  coalesce(p.today_points, 0)                     as today_points,
  coalesce(a.adjustment_points, 0)                as adjustment_points,
  g.ncaa_game_id                                  as today_game_id,
  g.is_home                                       as today_is_home,
  g.opponent                                      as today_opponent,
  g.opponent_rank                                 as today_opponent_rank,
  g.opponent_conference                           as today_opponent_conference,
  g.potential_points                              as today_potential_points,
  g.team_score                                    as today_team_score,
  g.opponent_score                                as today_opponent_score,
  g.game_state                                    as today_game_state,
  g.start_time                                    as today_start_time
from public.rosters r
join public.seasons s  on s.id = r.season_id
join public.managers m on m.id = r.manager_id
join public.teams t    on t.name = r.team_name
left join lateral (
  select
    sum(tgp.points) as game_points,
    sum(tgp.points) filter (where tgp.game_date = public.current_game_day()) as today_points
  from public.team_game_points tgp
  where tgp.season_id = r.season_id and tgp.team_name = r.team_name
) p on true
left join lateral (
  select sum(pa.points) as adjustment_points
  from public.point_adjustments pa
  where pa.season_id = r.season_id and pa.team_name = r.team_name
) a on true
left join lateral (
  select
    gm.ncaa_game_id,
    gm.home_team = r.team_name                                                    as is_home,
    case when gm.home_team = r.team_name then gm.away_team else gm.home_team end  as opponent,
    case when gm.home_team = r.team_name then gm.away_rank else gm.home_rank end  as opponent_rank,
    case when gm.home_team = r.team_name then gm.away_conference else gm.home_conference end as opponent_conference,
    case when gm.home_team = r.team_name then gm.home_potential_points else gm.away_potential_points end as potential_points,
    case when gm.home_team = r.team_name then gm.home_score else gm.away_score end as team_score,
    case when gm.home_team = r.team_name then gm.away_score else gm.home_score end as opponent_score,
    gm.game_state,
    gm.start_time
  from public.games gm
  where gm.game_date = public.current_game_day()
    and r.team_name in (gm.home_team, gm.away_team)
  order by gm.start_time nulls last
  limit 1
) g on true;

-- Manager leaderboard. previous_rank is the rank before today's points, for the
-- up/down movement indicator.
create view public.manager_standings
with (security_invoker = true)
as
select
  season_id,
  season_label,
  manager_id,
  manager_name,
  sum(total_points)                                                       as total_points,
  sum(today_points)                                                       as today_points,
  count(*)                                                                as team_count,
  rank() over (partition by season_id order by sum(total_points) desc)                     as current_rank,
  rank() over (partition by season_id order by sum(total_points) - sum(today_points) desc) as previous_rank
from public.team_standings
group by season_id, season_label, manager_id, manager_name;

-- Live scoreboard for the current game day.
create view public.todays_games
with (security_invoker = true)
as
select ncaa_game_id, start_time, game_state, current_period, contest_clock, is_final,
       home_team, home_rank, home_score, home_winner, home_odds,
       away_team, away_rank, away_score, away_winner, away_odds,
       updated_at
from public.games
where game_date = public.current_game_day();

------------------------------------------------------------------------------
-- Row level security: public read, service-role write
------------------------------------------------------------------------------

alter table public.seasons           enable row level security;
alter table public.managers          enable row level security;
alter table public.conference_tiers  enable row level security;
alter table public.teams             enable row level security;
alter table public.rosters           enable row level security;
alter table public.games             enable row level security;
alter table public.team_game_points  enable row level security;
alter table public.point_adjustments enable row level security;

create policy "public read" on public.seasons           for select to anon, authenticated using (true);
create policy "public read" on public.managers          for select to anon, authenticated using (true);
create policy "public read" on public.conference_tiers  for select to anon, authenticated using (true);
create policy "public read" on public.teams             for select to anon, authenticated using (true);
create policy "public read" on public.rosters           for select to anon, authenticated using (true);
create policy "public read" on public.games             for select to anon, authenticated using (true);
create policy "public read" on public.team_game_points  for select to anon, authenticated using (true);
create policy "public read" on public.point_adjustments for select to anon, authenticated using (true);
