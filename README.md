# Fantasy Hoops Revamped

Web-app rebuild of the Google Sheets / Apps Script college basketball fantasy game.

- **Database**: Postgres via self-hosted Supabase. Schema in `supabase/migrations/`.
- **Scoring + data sync**: Supabase edge functions (Deno) in `supabase/functions/`, run on a
  schedule by pg_cron.
- **Web app**: Next.js in `app/`. Server components read the standings views with the anon key,
  so only the web app needs to be exposed publicly.

Deployment on a Proxmox home server: [docs/deploy-proxmox.md](docs/deploy-proxmox.md).

## How scoring works

`sync-scores` pulls the NCAA scoreboard for a game day, stores games involving rostered
teams in `games`, and writes one `team_game_points` row per rostered team per scored
game. Totals are sums over that ledger plus `point_adjustments` (buy-game losses, manual
fixes), so there is no "settle" step and re-running any date is safe.

The game day is Central time with a 3am rollover, the same as the Sheets version.

Read models for the UI:

| View | Contents |
|---|---|
| `team_standings` | each rostered team: total, today's points, today's opponent and potential points |
| `manager_standings` | manager totals, today's points, current and previous rank |
| `todays_games` | live scoreboard for the current game day |

Conference tiers live in the `conference_tiers` table. A conference missing from that
table is scored as non-D1, and `sync-scores` lists any it sees under `unknownConferences`.

## Edge functions

All are `POST` and require the **service role** key as `Authorization: Bearer ...`.

| Function | Body | Purpose |
|---|---|---|
| `sync-scores` | `{}`, `{"date":"yesterday"}`, `{"date":"YYYY-MM-DD"}`, or `{"startDate","endDate"}` (31 days max) | games + scoring |
| `sync-rankings` | none | AP Top 25 into `teams.ap_rank` |
| `update-odds` | none | fetch NCAAB moneylines (not yet matched to games) |
| `sync-buy-games` | none, or `{"dryRun":true}` | buy-game posts (via a self-hosted RSSHub feed) into −2 adjustments; see the deploy guide |

## Development

```bash
cp .env.example .env.local   # point SUPABASE_URL / SUPABASE_ANON_KEY at your Supabase
npm install
npm run dev                  # Next.js on :3000
```

Edge functions (needs [Deno](https://deno.com), or use `npx deno`):

```bash
cd supabase/functions
deno task test         # scoring/date unit tests
deno task check        # type-check all functions
deno lint && deno fmt --check
```

## Scripts
- `npm run dev`: start the local development server.
- `npm run build`: build the app for production.
- `npm run start`: start the production server.
- `npm run lint`: run lint checks.
- `scripts/deploy-functions.sh`: copy edge functions into a self-hosted Supabase install.
- `scripts/import_league.py`: turn the league workbook (tiers, teams, draft) into SQL.
