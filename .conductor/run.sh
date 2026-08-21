#!/usr/bin/env bash
#
# Conductor run script -- starts this workspace's web app and worker on the
# ports the setup script allocated to it.
#
# Everything that makes this workspace distinct lives in its .env.local, so the
# job here is to load that file into the environment BEFORE npm scripts expand
# it: `next dev -p ${WEB_PORT:-3000}` is expanded by the shell that launches
# Next, long before Node reads any dotenv file.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=./lib.sh
source "${script_dir}/lib.sh"

cd "$(workspace_path)"

ENV_FILE="$(workspace_path)/.env.local"
if [ ! -f "${ENV_FILE}" ]; then
  echo "conductor: no .env.local -- run .conductor/setup.sh first" >&2
  exit 1
fi

load_env_file "${ENV_FILE}"

: "${WEB_PORT:=3000}"
: "${WORKER_WS_PORT:=8787}"
export WEB_PORT WORKER_WS_PORT

# The shared Postgres may be down after a reboot even though this workspace's
# database still exists. Starting it is cheap and every workspace wants it.
ensure_postgres >/dev/null

echo "conductor: web        http://127.0.0.1:${WEB_PORT}"
echo "conductor: worker ws  ws://127.0.0.1:${WORKER_WS_PORT}"
echo "conductor: database   ${DATABASE_URL:-<unset>}"
echo "conductor: data dir   ${CODEX_DATA_DIR:-<default>}"

# exec, so Conductor's SIGHUP reaches the dev servers rather than a wrapper.
exec pnpm dev
