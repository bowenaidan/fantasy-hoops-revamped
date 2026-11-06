-- Betting lines from The Odds API, filled in by the update-odds edge function.
-- home_odds / away_odds (already in the table) are American moneylines (-1200, +750).
-- home_spread is the home team's point spread (-4.5 = home favored by 4.5); the away
-- spread is its negative. Only pre-game rows are updated, so after tip-off these hold
-- the last line before the game. apply_day_sync never touches these columns.

alter table public.games
  add column home_spread     numeric(4, 1),
  add column odds_bookmaker  text,
  add column odds_updated_at timestamptz;

-- New columns go at the end, which create or replace view allows.
create or replace view public.todays_games
with (security_invoker = true)
as
select ncaa_game_id, start_time, game_state, current_period, contest_clock, is_final,
       home_team, home_rank, home_score, home_winner, home_odds,
       away_team, away_rank, away_score, away_winner, away_odds,
       updated_at,
       home_spread, odds_bookmaker, odds_updated_at
from public.games
where game_date = public.current_game_day();
