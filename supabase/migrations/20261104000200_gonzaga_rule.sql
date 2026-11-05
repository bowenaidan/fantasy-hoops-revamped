-- Per-team tier override for non-conference games.
--
-- League rule ("The Gonzaga Rule", Point Structure sheet): Gonzaga counts as a high
-- major team for non-conference games and high mid major for conference games. The
-- conference-game part needs no override: Gonzaga is in the Pac-12, which is highMid.
-- The override applies both ways: to Gonzaga's own wins and to teams that beat Gonzaga.

alter table public.teams
  add column nonconference_tier text
  check (nonconference_tier in ('highMajor', 'highMid', 'trueMid', 'lowMajor'));

comment on column public.teams.nonconference_tier is
  'Tier used for this team in non-conference games instead of its conference''s tier (e.g. the Gonzaga Rule).';

insert into public.teams (name, nonconference_tier) values ('Gonzaga', 'highMajor')
on conflict (name) do update set nonconference_tier = excluded.nonconference_tier;
