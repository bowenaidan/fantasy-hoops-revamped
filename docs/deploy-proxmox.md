# Deploying on a Proxmox home server

Everything runs in one Debian VM: self-hosted Supabase (Postgres, PostgREST, the
edge-function runtime, pg_cron) in Docker, and the Next.js app under systemd.

```
Proxmox
└─ VM (Debian 12, Docker)
   ├─ Supabase compose stack: db, kong :8000, rest, functions, studio, ...
   │    pg_cron ──HTTP──▶ kong:8000/functions/v1/sync-scores ──▶ NCAA API
   └─ fantasy-hoops Next.js app :3000 (systemd) ──▶ kong:8000/rest/v1 (anon key)
```

Only port 3000 is ever published outside your network (step 10).

All commands below run **inside the VM** unless noted. The examples call the VM
`supabase-vm.lan`; use its IP or hostname.

## 1. Create the VM

In the Proxmox UI (Create VM):

- **OS**: Debian 12 netinst ISO.
- **CPU / RAM / disk**: 2 vCPU, 4–8 GB RAM (the Supabase stack is about 10 containers), 40 GB.
- **Network**: give it a fixed address (a DHCP reservation in your router is easiest).
- Use a **VM, not an LXC container**. Docker inside LXC works until a Proxmox upgrade
  breaks it (overlayfs/AppArmor); Proxmox recommends VMs for Docker.

During the Debian install, deselect the desktop environment and select "SSH server".

## 2. Install the basics

```bash
sudo apt update && sudo apt install -y git rsync curl python3 ca-certificates

# Docker Engine + compose plugin (official repo; see docs.docker.com/engine/install/debian)
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt update && sudo apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo usermod -aG docker "$USER"    # then log out and back in

# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

## 3. Self-hosted Supabase

Follow https://supabase.com/docs/guides/self-hosting/docker. In short:

```bash
git clone --depth 1 https://github.com/supabase/supabase /tmp/supabase-src
sudo mkdir -p /opt/supabase && sudo cp -r /tmp/supabase-src/docker /opt/supabase/docker
sudo chown -R "$USER": /opt/supabase
cd /opt/supabase/docker && cp .env.example .env
```

Generate every secret (the defaults in `.env.example` are public; never keep them):

```bash
cd /opt/supabase/docker
sh utils/generate-keys.sh --update-env
```

This creates a new `JWT_SECRET`, the `ANON_KEY` and `SERVICE_ROLE_KEY` signed with it,
`POSTGRES_PASSWORD`, `DASHBOARD_PASSWORD` and the other internal secrets, and writes them
into `.env` (the previous file is kept as `.env.old`). Save the printed output in a password
manager. Don't run `utils/add-new-auth-keys.sh`: this app uses the `ANON_KEY` /
`SERVICE_ROLE_KEY` pair.

Then edit `/opt/supabase/docker/.env`:

- `SUPABASE_PUBLIC_URL=http://supabase-vm.lan:8000` (your VM's IP or hostname), so Studio
  works from your own computer. Set `API_EXTERNAL_URL` to the same host
  (`http://supabase-vm.lan:8000/auth/v1`).
- Optionally change `DASHBOARD_USERNAME` (the Studio login).
- Add `ODDS_API_KEY=...` (your key from the-odds-api.com).

Recent versions of this stack use Envoy as the API gateway (service `api-gw`) instead of
Kong. It keeps `kong` as a network alias and listens on port 8000, so everything below works
with either.

In `docker-compose.yml`, add the app's settings to the `functions` service:

```yaml
  functions:
    environment:
      # ...existing entries...
      ODDS_API_KEY: ${ODDS_API_KEY}
      # NCAA_API_BASE: http://ncaa-api:3000   # only if you self-host the NCAA proxy (optional, below)
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are already passed to functions by the
stock compose file. Start it:

```bash
docker compose up -d
docker compose ps        # everything should become "healthy"
```

Studio (the dashboard) is at `http://supabase-vm.lan:8000`, using the dashboard login.

Two shortcuts the rest of this guide uses (add them to `~/.bashrc` if you like):

```bash
# psql inside the database container
alias fhsql='docker exec -i supabase-db psql -U postgres -v ON_ERROR_STOP=1'
# read a value out of Supabase's .env
envval() { grep "^$1=" /opt/supabase/docker/.env | cut -d= -f2-; }
```

Running psql through `docker exec` avoids exposing Postgres or typing its password. (Port
5432 on the VM goes through Supabase's connection pooler, which expects a special
username, so plain `psql -h ... -U postgres` doesn't work there anyway.)

## 4. Get the code and create the schema

```bash
git clone https://github.com/bowenaidan/fantasy-hoops-revamped ~/fantasy-hoops
cd ~/fantasy-hoops
for f in supabase/migrations/*.sql; do echo "$f"; fhsql < "$f"; done
```

## 5. Deploy the edge functions

```bash
SUPABASE_DOCKER_DIR=/opt/supabase/docker ./scripts/deploy-functions.sh
```

This copies the functions next to Supabase's own `main` router and restarts the functions
container. (From another machine, `SUPABASE_DOCKER_DIR=you@supabase-vm.lan:/opt/supabase/docker`
does the same over SSH.)

The sync functions only accept the service role key, never the anon key.

## 6. Import the league

Copy the workbook to the VM (run this **on your own computer**):

```bash
scp "College Hoops Teams League.xlsx" you@supabase-vm.lan:~/fantasy-hoops/
```

Then on the VM:

```bash
cd ~/fantasy-hoops
./scripts/import_league.py "College Hoops Teams League.xlsx" \
  --season 2026-27 --start 2026-11-02 --end 2027-04-06 > import.sql
fhsql < import.sql
```

The importer reads the `Conference Tiers` and `2026-2027 DRAFT` sheets (full manager
names come from the standings sheet), matches spreadsheet names to NCAA names, and prints
what it found. If any team can't be matched it writes no SQL and exits with an error: add
the spelling to `ALIASES` in the script. Re-running after draft changes is safe; teams that
stay keep their points. (The Gonzaga Rule comes from a migration, not the workbook.)

## 7. Backfill games already played

`sync-scores` takes at most 31 days per call, so this loops in chunks up to today:

```bash
KEY=$(envval SERVICE_ROLE_KEY)
start=2026-11-02
today=$(TZ=America/Chicago date +%F)
while [[ ! "$start" > "$today" ]]; do
  end=$(date -d "$start +30 days" +%F)
  curl -s -X POST http://localhost:8000/functions/v1/sync-scores \
    -H "Authorization: Bearer $KEY" -d "{\"startDate\":\"$start\",\"endDate\":\"$end\"}"
  echo
  start=$(date -d "$end +1 day" +%F)
done
```

Check `unknownConferences` in the output. Every conference listed there is scored as
**non-D1** (the -4 rule). D2/D3 conferences (`mwc`, `sciac`, `nsic`, ...) belong there. If
a D1 conference shows up, give it a tier and re-run the sync for the affected dates:

```bash
echo "insert into conference_tiers values ('<conference-seo>', 'lowMajor');" | fhsql
```

Re-running a sync is always safe.

### Buy-game losses and manual corrections

Buy-game losses can be picked up automatically from Jon Rothstein's posts (see
[Buy-game feed](#optional-buy-game-feed) below), or entered by hand. For example,
Oklahoma's 2026-27 buy-game loss:

```bash
fhsql <<'SQL'
insert into point_adjustments (season_id, team_name, points, kind, game_date, note)
select id, 'Oklahoma', -2, 'buy_game_loss', '2026-11-02', 'Lost 64-68 at home to East Texas A&M'
from seasons where label = '2026-27';
SQL
```

## 8. Schedule the syncs

```bash
cd ~/fantasy-hoops
fhsql -v service_role_key="$(envval SERVICE_ROLE_KEY)" < supabase/schedule.sql
```

This stores the service role key in Vault and creates three pg_cron jobs (times in UTC):

| Job | When | What |
|---|---|---|
| `sync-today` | every 10 minutes | today's games and points |
| `sync-yesterday` | 10:15 UTC daily | re-checks yesterday after the 3am Central rollover |
| `sync-rankings` | 18:00 UTC daily | AP Top 25 |
| `sync-buy-games` | :07 and :37 past each hour | buy-game posts (only once the feed below is set up) |

Re-run the same command after changing `SERVICE_ROLE_KEY`. To check on the jobs:

```bash
echo "select j.jobname, d.status, d.start_time, left(d.return_message, 80) from cron.job_run_details d join cron.job j using (jobid) order by d.start_time desc limit 10;" | fhsql
echo "select status_code, left(content, 200) from net._http_response order by created desc limit 5;" | fhsql
```

## 9. Run the web app

```bash
cd ~/fantasy-hoops
printf 'SUPABASE_URL=http://localhost:8000\nSUPABASE_ANON_KEY=%s\n' "$(envval ANON_KEY)" > .env.local
npm ci
npm run build
```

The app only ever gets the **anon** key, never the service role key. It reads Supabase on
the server, so browsers never talk to Supabase directly.

Create `/etc/systemd/system/fantasy-hoops.service` (replace `aidan` with your VM username):

```ini
[Unit]
Description=Fantasy Hoops web app
After=network-online.target docker.service
Wants=network-online.target

[Service]
User=aidan
WorkingDirectory=/home/aidan/fantasy-hoops
Environment=NODE_ENV=production
Environment=PORT=3000
ExecStart=/usr/bin/npm run start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now fantasy-hoops
systemctl status fantasy-hoops        # logs: journalctl -u fantasy-hoops -f
```

The site is now at `http://supabase-vm.lan:3000` on your network.

## 10. Sharing it with the league

- **Don't port-forward anything** on your router: not 3000, not Kong (8000), Studio or Postgres.
- Publish only port 3000 through **Cloudflare Tunnel** (free; needs a domain on Cloudflare)
  or **Tailscale Funnel** (free; gives a `*.ts.net` URL). Both connect outbound, so no
  firewall changes are needed.
  - Cloudflare: install `cloudflared` in the VM, create a tunnel, and route a hostname to
    `http://localhost:3000`.
  - Tailscale: install Tailscale in the VM, then `sudo tailscale funnel --bg 3000`.
- Studio stays reachable only from your network (or over Tailscale).

## 11. Backups

- **Proxmox**: schedule a backup of the VM (Datacenter → Backup), ideally to a Proxmox
  Backup Server or a NAS. That covers everything, including Supabase's `.env`.
- **Database**: a nightly dump, in root's crontab (`sudo crontab -e`):

  ```
  0 9 * * * docker exec supabase-db pg_dump -U postgres -Fc postgres > /var/backups/fantasy-$(date +\%F).dump && find /var/backups -name 'fantasy-*.dump' -mtime +30 -delete
  ```

  Restore with `pg_restore`. Scores can also be rebuilt for any date range just by
  re-running `sync-scores` (step 7), since they're computed from game data.

## 12. Updating later

```bash
cd ~/fantasy-hoops && git pull
for f in supabase/migrations/*.sql; do echo "$f"; fhsql < "$f"; done   # see note below
SUPABASE_DOCKER_DIR=/opt/supabase/docker ./scripts/deploy-functions.sh
npm ci && npm run build && sudo systemctl restart fantasy-hoops
```

Migrations are **not** all safe to re-run: apply only the new files (compare
`git diff --name-only HEAD@{1} -- supabase/migrations` after the pull). If a migration
changed scoring rules, re-run the sync for the season (step 7).

## Optional: buy-game feed

`sync-buy-games` reads Jon Rothstein's X posts through a self-hosted
[RSSHub](https://docs.rsshub.app) and turns "*Team* loses a buy game to *Team*." posts into
−2 `buy_game_loss` adjustments for rostered teams.

RSSHub reads X as a logged-in account, which is against X's terms. **Use a throwaway X
account**, not your own: it can get locked or banned, and then the feed stops until you
swap in another account's cookie.

1. Create the throwaway account, log in to x.com with it in a browser, and copy its
   `auth_token` cookie (developer tools → Application/Storage → Cookies → `https://x.com`).
   It's a password-equivalent for that account: keep it out of git and chat.
2. Add it to `/opt/supabase/docker/.env`:

   ```
   TWITTER_AUTH_TOKEN=<the cookie value>
   ```

3. Add RSSHub to the Supabase stack and restart it:

   ```bash
   cd /opt/supabase/docker
   cp ~/fantasy-hoops/deploy/docker-compose.override.yml fantasy-hoops.override.yml
   main=$(ls docker-compose.yml compose.yaml compose.yml 2>/dev/null | head -1)
   sed -i '/^COMPOSE_FILE=/d' .env
   echo "COMPOSE_FILE=$main:fantasy-hoops.override.yml" >> .env
   docker compose config --services | grep rsshub    # must list rsshub and rsshub-redis
   docker compose up -d
   ```

   `COMPOSE_FILE` tells Compose to load both files, rather than relying on its automatic
   override naming (which only works when the names match the main file's style, and is
   ignored if `COMPOSE_FILE` is already set). The extra file adds `rsshub` and its Redis cache
   (no published ports) and sets `BUY_GAME_FEED_URL` for the functions. If you edit
   `.env` by hand later, keep that one `COMPOSE_FILE` line.

   When `deploy/docker-compose.override.yml` changes in the repo, copy it again and run
   `docker compose up -d`.

4. Check the feed, then do a dry run (prints what it would record, writes nothing):

   ```bash
   docker compose exec rsshub node -e "fetch('http://localhost:1200/twitter/user/JonRothstein/includeRts=0').then(r => r.text()).then(t => console.log(t.slice(0, 800)))"
   curl -s -X POST http://localhost:8000/functions/v1/sync-buy-games \
     -H "Authorization: Bearer $(envval SERVICE_ROLE_KEY)" -d '{"dryRun":true}'; echo
   ```

   The first command should print RSS XML with his recent posts. An error page there
   usually means a bad or expired cookie; `docker compose logs rsshub` has the details.

5. Re-run `schedule.sql` (step 8) to add the `sync-buy-games` job.

How it decides:

- The post must match "*X* loses/drops a buy game to *Y*". Retweets and replies aren't read.
- *X* must have **lost a finished game** on the post's game day or up to two days before.
  If *Y*'s name also matches, that game is used; otherwise only a single loss in that window
  counts. Anything ambiguous is skipped.
- *X* must be **rostered** that season. Posts about other teams show up under
  `noLeagueGame` and are ignored.
- Each post is recorded once (its URL is stored as `source_url`). A team that already has a
  buy-game loss for that day, including one entered by hand, isn't penalized twice.

Spellings that don't match an NCAA name ("Ole Miss", "UConn", ...) go in
`supabase/functions/_shared/team_aliases.json`, which the league importer uses too. To undo
an adjustment it got wrong:

```bash
echo "delete from point_adjustments where source_url = 'https://x.com/JonRothstein/status/<id>';" | fhsql
```

If the cookie stops working (RSSHub logs show auth errors, or the dry run reports a feed
error), log in again or use a new throwaway account, update `TWITTER_AUTH_TOKEN`, and run
`docker compose up -d rsshub`.

## Optional: self-host the NCAA API

The public `ncaa-api.henrygd.me` instance is limited to about 5 requests/second and can go
down. The project (github.com/henrygd/ncaa-api) ships a Docker image; add it as a service
in Supabase's compose file and set `NCAA_API_BASE` (step 3) to point at it.
