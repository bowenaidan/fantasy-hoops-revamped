# Deploying on a Proxmox home server

Everything runs on self-hosted Supabase (Postgres, PostgREST, the edge-function
runtime, pg_cron) in one VM. The Next.js app can run in the same VM or its own
LXC container.

```
Proxmox
└─ VM "supabase" (Debian 12, Docker)
   ├─ supabase/docker compose stack: db, kong :8000, rest, functions, studio, ...
   │    pg_cron ──HTTP──▶ kong:8000/functions/v1/sync-scores ──▶ NCAA API
   └─ (optional) fantasy-hoops Next.js app, or a separate LXC
```

## 1. VM

- Use a **VM, not an LXC**, for the Docker stack. Docker in unprivileged LXCs works but
  breaks on Proxmox upgrades (overlayfs/AppArmor). Proxmox recommends VMs for Docker.
- Debian 12, 2 vCPU, **4 GB RAM minimum** (the Supabase stack is ~10 containers), 30 GB disk.
- Give it a DHCP reservation or static IP. These docs use `supabase-vm.lan`.
- Install Docker Engine + the compose plugin (docs.docker.com/engine/install/debian).

## 2. Self-hosted Supabase

Follow https://supabase.com/docs/guides/self-hosting/docker. In short:

```bash
git clone --depth 1 https://github.com/supabase/supabase /opt/supabase-src
cp -r /opt/supabase-src/docker /opt/supabase/docker
cd /opt/supabase/docker && cp .env.example .env
```

In `.env`, **change every secret**: `POSTGRES_PASSWORD`, `JWT_SECRET`, `ANON_KEY` and
`SERVICE_ROLE_KEY` (generate both keys from your JWT_SECRET using the tool in the
self-hosting docs), and `DASHBOARD_USERNAME`/`DASHBOARD_PASSWORD`. Then `docker compose up -d`.

Add the app's function settings to the `functions` service in `docker-compose.yml`:

```yaml
  functions:
    environment:
      # ...existing entries...
      ODDS_API_KEY: ${ODDS_API_KEY}
      # NCAA_API_BASE: http://ncaa-api:3000   # only if you self-host the NCAA proxy (step 6)
```

…and put `ODDS_API_KEY=...` in `.env`. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`
are already passed to functions by the stock compose file.

## 3. Database schema

Apply the migrations in order (from any machine that can reach Postgres):

```bash
for f in supabase/migrations/*.sql; do
  psql "postgres://postgres:$POSTGRES_PASSWORD@supabase-vm.lan:5432/postgres" -v ON_ERROR_STOP=1 -f "$f"
done
```

(The Supabase CLI also works: `supabase db push --db-url postgres://...`.)

Postgres is reachable on 5432 (via Supavisor) from your LAN by default. Don't port-forward it.

## 4. Edge functions

```bash
SUPABASE_DOCKER_DIR=you@supabase-vm.lan:/opt/supabase/docker ./scripts/deploy-functions.sh
```

Smoke test (service role key from `.env`):

```bash
curl -X POST http://supabase-vm.lan:8000/functions/v1/sync-scores \
  -H "Authorization: Bearer $SERVICE_ROLE_KEY" -d '{}'
```

The sync functions reject anything but the service role key, including the anon key.

## 5. League setup

Load conference tiers, every D1 team, managers and the draft from the league workbook:

```bash
scripts/import_league.py "College Hoops Teams League.xlsx" \
  --season 2026-27 --start 2026-11-02 --end 2027-04-06 > import.sql
psql "postgres://postgres:$POSTGRES_PASSWORD@supabase-vm.lan:5432/postgres" -v ON_ERROR_STOP=1 -f import.sql
```

It reads the `Conference Tiers` and `2026-2027 DRAFT` sheets (full manager names come from
the standings sheet), matches spreadsheet names to NCAA names, prints what it found, and
refuses to write SQL if any team can't be matched (add the spelling to `ALIASES` in the
script). Re-running after draft changes is safe: teams that stay keep their points.
The Gonzaga Rule is set by a migration (`teams.nonconference_tier`).

Backfill games already played (max 31 days per call):

```bash
for range in '2026-11-02 2026-12-02' '2026-12-03 2027-01-02'; do
  set -- $range
  curl -s -X POST http://supabase-vm.lan:8000/functions/v1/sync-scores \
    -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
    -d "{\"startDate\":\"$1\",\"endDate\":\"$2\"}"
done
```

Watch the `unknownConferences` field in the response. Any conference listed there is
being scored as **non-D1** (the -4 rule). If it's actually D1, add it:

```sql
insert into conference_tiers values ('<conference-seo>', 'lowMajor');  -- or highMajor / highMid / trueMid
```

…then re-run the sync for the affected dates. Re-running is always safe.

Buy-game losses and manual corrections:

```sql
insert into point_adjustments (season_id, team_name, points, kind, game_date, note)
select id, 'Kentucky', -5, 'buy_game_loss', '2026-11-20', 'Lost at home to a 300+ KenPom team'
from seasons where label = '2026-27';
```

## 6. Scheduling (pg_cron)

Run in the SQL editor (Studio) or psql as `postgres`. pg_cron times are **UTC**.

```sql
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net  with schema extensions;

-- Store the service role key once; cron jobs read it from the vault.
select vault.create_secret('<SERVICE_ROLE_KEY>', 'service_role_key');

-- Kept out of the public schema so PostgREST never exposes it.
create schema if not exists private;
create or replace function private.call_function(fn text, body jsonb default '{}')
returns bigint language sql as $$
  select net.http_post(
    url := 'http://kong:8000/functions/v1/' || fn,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
    ),
    body := body,
    timeout_milliseconds := 120000
  );
$$;
revoke execute on function private.call_function(text, jsonb) from public, anon, authenticated;

-- Live scores + today's points every 10 minutes
select cron.schedule('sync-today',     '*/10 * * * *', $$select private.call_function('sync-scores')$$);
-- Re-check yesterday after the 3am Central rollover (catches late finals/corrections)
select cron.schedule('sync-yesterday', '15 10 * * *',  $$select private.call_function('sync-scores', '{"date":"yesterday"}')$$);
-- AP poll (released Mondays; daily is cheap)
select cron.schedule('sync-rankings',  '0 18 * * *',   $$select private.call_function('sync-rankings')$$);
```

`kong` resolves because the database container is on the compose network. Check runs with
`select * from cron.job_run_details order by start_time desc limit 20;` and responses with
`select * from net._http_response order by created desc limit 20;`.

Optional: the NCAA API proxy (github.com/henrygd/ncaa-api) ships a Docker image. Running
it in the same compose project avoids the public instance's 5 req/s limit and outages;
set `NCAA_API_BASE` as shown in step 2.

## 7. Next.js app

```bash
cp .env.example .env.local   # SUPABASE_URL=http://localhost:8000 if in the same VM, plus ANON_KEY
npm ci && npm run build && npm run start   # port 3000
```

Run it under systemd (or `docker build` it into the same compose project). It reads
Supabase on the server only, with the anon key. Never give it the service role key.
The page reloads its data every minute while open, matching the 10-minute sync closely
enough without hammering anything.

## 8. Exposing it outside your network

- Don't port-forward Kong (8000), Studio, or Postgres.
- Use **Cloudflare Tunnel** or **Tailscale Funnel** to publish only the Next.js app (port 3000).
  The browser never talks to Supabase directly, so nothing else needs to be public.
- Studio (the dashboard) stays LAN or Tailscale only.

## 9. Backups

The Sheets version had `backupTeams()`. Here:

- **Proxmox**: schedule a `vzdump` backup of the VM (Datacenter → Backup), ideally to a
  Proxmox Backup Server or a NAS.
- **Database**: a nightly logical dump in the VM's crontab:
  ```
  0 9 * * * docker exec supabase-db pg_dump -U postgres -Fc postgres > /var/backups/fantasy-$(date +\%F).dump
  ```
  Restore with `pg_restore`. Because scores are an idempotent ledger, you can also rebuild
  any date range just by re-running `sync-scores`.
