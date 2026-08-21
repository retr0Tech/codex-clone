#!/usr/bin/env bash
#
# Conductor setup script -- runs once, when a workspace is created (and again
# whenever you ask Conductor to re-run it).
#
# Gives this workspace its own identity for every resource the app would
# otherwise share with a sibling workspace: database, web port, worker
# WebSocket port, host data directory (mirrors, snapshots, job specs and the
# model-gateway unix socket), and the Docker label the worker reconciles
# against. Then installs, migrates, and writes the workspace's .env.local.
#
# Idempotent by construction: run it twice and the second run reuses the ports
# and database it allocated the first time.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=./lib.sh
source "${script_dir}/lib.sh"

cd "$(workspace_path)"

WS_PATH="$(workspace_path)"
WS_ID="$(workspace_id)"
DATA_DIR="$(workspace_data_dir)"
DB_NAME="$(workspace_db_name)"
ENV_FILE="${WS_PATH}/.env.local"
PARENT_ENV="$(repo_root_path)/.env.local"

echo "conductor: workspace ${WS_ID}"
echo "conductor: path      ${WS_PATH}"

# --- 1. dependencies --------------------------------------------------------
#
# A worktree is a fresh checkout with no node_modules, and pnpm's store is
# shared and content-addressed, so this is mostly hard links.
if ! command -v pnpm >/dev/null 2>&1; then
  corepack enable >/dev/null 2>&1 || true
fi
echo "conductor: installing dependencies"
pnpm install --frozen-lockfile

# --- 2. ports ---------------------------------------------------------------
#
# Reuse what a previous run of this script already recorded, so re-running
# setup does not move a workspace's ports out from under a running server.
WEB_PORT="$(env_file_get "${ENV_FILE}" WEB_PORT)"
WS_PORT="$(env_file_get "${ENV_FILE}" WORKER_WS_PORT)"

if [ -z "${WEB_PORT}" ]; then
  # Conductor hands each local workspace ten consecutive ports starting at
  # CONDUCTOR_PORT. When it is set it is the best seed available -- Conductor
  # already guarantees the range is this workspace's alone -- but the reserver
  # still verifies it rather than trusting it blindly, because outside
  # Conductor there is no such guarantee.
  WEB_PORT="$(reserve_port web "${CONDUCTOR_PORT:-}" 3000 3099)"
fi
if [ -z "${WS_PORT}" ]; then
  preferred=""
  [ -n "${CONDUCTOR_PORT:-}" ] && preferred="$((CONDUCTOR_PORT + 1))"
  WS_PORT="$(reserve_port worker-ws "${preferred}" 8787 8886)"
fi
echo "conductor: web :${WEB_PORT}   worker ws :${WS_PORT}"

# --- 3. host data directory -------------------------------------------------
#
# CODEX_DATA_DIR holds the bare mirrors, the cold snapshots, the job specs and
# -- the one that is a hard conflict rather than merely messy -- the model
# gateway's unix socket. Two workers bound to one socket path is not a race
# that resolves; the second one fails or silently steals the first one's
# sandboxes' model calls.
mkdir -p "${DATA_DIR}/mirrors" "${DATA_DIR}/snapshots" "${DATA_DIR}/jobs"
chmod 700 "${DATA_DIR}"
echo "conductor: data dir  ${DATA_DIR}"

# --- 4. database ------------------------------------------------------------
#
# One DATABASE per workspace inside the one shared Postgres server, not one
# server per workspace and not one row-set per workspace. A schema shared with
# a filter column would still let a migration on one branch break another.
container="$(ensure_postgres)"
echo "conductor: postgres  ${container}"

if psql_admin -tAc "SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'" | grep -q 1; then
  echo "conductor: database  ${DB_NAME} (exists)"
else
  psql_admin -c "CREATE DATABASE \"${DB_NAME}\" OWNER codex" >/dev/null
  echo "conductor: database  ${DB_NAME} (created)"
fi

DATABASE_URL="postgres://codex:codex@127.0.0.1:5432/${DB_NAME}"

# --- 5. the encryption key --------------------------------------------------
#
# APP_ENCRYPTION_KEY decrypts the GitHub PAT and OpenAI key that Settings wrote
# into Postgres. A workspace with a NEW key cannot read credentials entered
# anywhere else -- and, worse, would let you paste them in again and quietly
# store a second, differently-keyed copy. So: reuse, and if reuse is impossible
# say so at the top of your voice rather than in a comment.
KEY="$(env_file_get "${ENV_FILE}" APP_ENCRYPTION_KEY)"
KEY_SOURCE="this workspace"
if [ -z "${KEY}" ]; then
  KEY="$(env_file_get "${PARENT_ENV}" APP_ENCRYPTION_KEY)"
  KEY_SOURCE="${PARENT_ENV}"
fi
KEY_IS_NEW=0
if [ -z "${KEY}" ]; then
  KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")"
  KEY_SOURCE="freshly generated"
  KEY_IS_NEW=1
fi

# --- 6. .env.local ----------------------------------------------------------
#
# One file at the workspace root; both the web app (apps/web/next.config.ts)
# and the worker (--env-file-if-exists) read it.
if [ ! -f "${ENV_FILE}" ]; then
  cp "${WS_PATH}/.env.example" "${ENV_FILE}"
fi
chmod 600 "${ENV_FILE}"

env_file_set "${ENV_FILE}" APP_ENCRYPTION_KEY "${KEY}"
env_file_set "${ENV_FILE}" DATABASE_URL "${DATABASE_URL}"
env_file_set "${ENV_FILE}" POSTGRES_DB "${DB_NAME}"
env_file_set "${ENV_FILE}" WEB_PORT "${WEB_PORT}"
env_file_set "${ENV_FILE}" WORKER_WS_PORT "${WS_PORT}"
env_file_set "${ENV_FILE}" NEXT_PUBLIC_WS_URL "ws://127.0.0.1:${WS_PORT}"
env_file_set "${ENV_FILE}" CODEX_DATA_DIR "${DATA_DIR}"
env_file_set "${ENV_FILE}" CODEX_WORKSPACE_ID "${WS_ID}"

# --- 7. migrations ----------------------------------------------------------
echo "conductor: migrating ${DB_NAME}"
DATABASE_URL="${DATABASE_URL}" pnpm db:migrate

# --- 8. the agent image -----------------------------------------------------
#
# Shared across workspaces on purpose: it is a read-only build artefact keyed
# by tag, so one build serves every worktree. Building it here would add
# minutes to every workspace creation for no isolation gain.
AGENT_IMAGE="$(env_file_get "${ENV_FILE}" AGENT_IMAGE)"
[ -n "${AGENT_IMAGE}" ] || AGENT_IMAGE="codex-clone/agent:dev"
if ! docker image inspect "${AGENT_IMAGE}" >/dev/null 2>&1; then
  echo "conductor: NOTE  the agent image ${AGENT_IMAGE} is not built yet."
  echo "conductor:       run 'pnpm agent:build' once; every workspace shares it."
fi

echo
echo "conductor: workspace ready"
echo "  database          ${DB_NAME}"
echo "  web               http://127.0.0.1:${WEB_PORT}"
echo "  worker websocket  ws://127.0.0.1:${WS_PORT}"
echo "  data dir          ${DATA_DIR}"
echo "  gateway socket    ${DATA_DIR}/gateway.sock"
echo "  encryption key    ${KEY_SOURCE}"

if [ "${KEY_IS_NEW}" = "1" ]; then
  cat <<'WARN'

  ############################################################################
  ##  A NEW APP_ENCRYPTION_KEY WAS GENERATED FOR THIS WORKSPACE.
  ##
  ##  No key was found in this workspace or in the parent checkout's
  ##  .env.local, so there was nothing to reuse. Credentials you saved in
  ##  Settings under a DIFFERENT key cannot be decrypted here -- and this
  ##  workspace has its own database anyway, so you will be entering the
  ##  GitHub PAT and OpenAI key again regardless.
  ##
  ##  To share one key across every workspace, put it in the parent
  ##  checkout's .env.local and re-run setup:
  ##
  ##      APP_ENCRYPTION_KEY=<the key>
  ############################################################################
WARN
fi
echo
