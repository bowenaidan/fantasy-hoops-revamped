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

Edit `/opt/supabase/docker/.env` and **change every secret**:

- `POSTGRES_PASSWORD`, `JWT_SECRET`, `DASHBOARD_USERNAME`, `DASHBOARD_PASSWORD`.
- `ANON_KEY` and `SERVICE_ROLE_KEY`: generate both from your `JWT_SECRET` as described in
  the self-hosting guide's API keys section. The defaults are public; never keep them.
- Add `ODDS_API_KEY=...` (your key from the-odds-api.com).

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

These are entered by hand. For example, Oklahoma's 2026-27 buy-game loss:

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

Re-run the same command after changing `SERVICE_ROLE_KEY`. To check on the jobs:

```bash
echo "select jobname, status, start_time from cron.job_run_details order by start_time desc limit 10;" | fhsql
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

## Optional: self-host the NCAA API

The public `ncaa-api.henrygd.me` instance is limited to about 5 requests/second and can go
down. The project (github.com/henrygd/ncaa-api) ships a Docker image; add it as a service
in Supabase's compose file and set `NCAA_API_BASE` (step 3) to point at it.
