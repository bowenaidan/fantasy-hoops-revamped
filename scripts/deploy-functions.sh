#!/usr/bin/env bash
# Copy edge functions into a self-hosted Supabase install and restart the runtime.
#
#   SUPABASE_DOCKER_DIR=/opt/supabase/docker ./scripts/deploy-functions.sh          # on the server
#   SUPABASE_DOCKER_DIR=me@supabase-vm:/opt/supabase/docker ./scripts/deploy-functions.sh   # from your machine
#
# Self-hosted Supabase serves every directory under docker/volumes/functions/ through its
# "main" router, so each function folder (plus _shared) is copied next to it. The router
# folder (main/) and anything else already there is left alone.
set -euo pipefail

: "${SUPABASE_DOCKER_DIR:?Set SUPABASE_DOCKER_DIR to the supabase/docker directory (local path or host:path)}"
SRC="$(cd "$(dirname "$0")/../supabase/functions" && pwd)"
DEST="${SUPABASE_DOCKER_DIR%/}/volumes/functions/"

for fn in _shared sync-scores sync-rankings update-odds sync-buy-games; do
  rsync -a --delete "$SRC/$fn/" "$DEST$fn/"
done
echo "Copied functions to $DEST"

if [[ "$SUPABASE_DOCKER_DIR" == *:* ]]; then
  host="${SUPABASE_DOCKER_DIR%%:*}"
  dir="${SUPABASE_DOCKER_DIR#*:}"
  ssh "$host" "cd '$dir' && docker compose restart functions"
else
  (cd "$SUPABASE_DOCKER_DIR" && docker compose restart functions)
fi
echo "Restarted the functions container."
