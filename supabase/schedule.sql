-- Scheduled syncs via pg_cron. Safe to re-run (updates the key and the jobs in place).
--
--   docker exec -i supabase-db psql -U postgres -v ON_ERROR_STOP=1 \
--     -v service_role_key="$SERVICE_ROLE_KEY" < supabase/schedule.sql
--
-- pg_cron schedules are in UTC.

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- Keep the service role key in Vault rather than in the job definitions.
select set_config('fh.service_role_key', :'service_role_key', false) <> '' as key_loaded;
do $$
declare
  existing uuid;
begin
  select id into existing from vault.secrets where name = 'service_role_key';
  if existing is null then
    perform vault.create_secret(current_setting('fh.service_role_key'), 'service_role_key');
  else
    perform vault.update_secret(existing, current_setting('fh.service_role_key'));
  end if;
end;
$$;

-- Not in the public schema, so the REST API never exposes it.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create or replace function private.call_function(fn text, body jsonb default '{}')
returns bigint
language sql
as $$
  select net.http_post(
    url := 'http://kong:8000/functions/v1/' || fn,  -- kong resolves on the compose network
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
    ),
    body := body,
    timeout_milliseconds := 120000
  );
$$;
revoke execute on function private.call_function(text, jsonb) from public, anon, authenticated;

-- Today's games and points, every 10 minutes.
select cron.schedule('sync-today', '*/10 * * * *', $$select private.call_function('sync-scores')$$);
-- Re-check yesterday after the 3am Central rollover (late finals, stat corrections).
select cron.schedule('sync-yesterday', '15 10 * * *', $$select private.call_function('sync-scores', '{"date":"yesterday"}')$$);
-- AP poll (released Mondays; daily is cheap).
select cron.schedule('sync-rankings', '0 18 * * *', $$select private.call_function('sync-rankings')$$);

select cron.schedule('sync-buy-games', '7,37 * * * *', $$select private.call_function('sync-buy-games')$$);

select jobname, schedule from cron.job order by jobname;
