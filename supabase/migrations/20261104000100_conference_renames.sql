-- The NCAA API changed some conferenceSeo values. Conferences missing from
-- conference_tiers score as non-D1 (-4), so these must be mapped.
--   metro : the MAAC (Fairfield, Iona, Manhattan, Marist, Quinnipiac, ...). 'maac' no longer appears.
--   uac-  : the WAC, renamed United Athletic Conference (Utah Valley, California Baptist, UT Arlington, ...).
--           'wac' no longer appears. Note the trailing dash is really in the API's value.
-- Both keep their previous lowMajor tier. The old keys are left in place in case they come back.
--   pac-12: the revived Pac-12 (Boise St., Colorado St., Oregon St., San Diego St., ...). Scored
--           highMid, the same as the Mountain West most of its members came from.
--
-- sync-scores reports any other unmapped conference in its "unknownConferences" output.
-- Some are legitimately non-D1 (e.g. 'mwc' is the D3 Midwest Conference, NOT the Mountain West).

insert into public.conference_tiers (conference_seo, tier) values
  ('metro', 'lowMajor'),
  ('uac-', 'lowMajor'),
  ('pac-12', 'highMid')
on conflict (conference_seo) do update set tier = excluded.tier;
