#!/usr/bin/env bash
#
# Conductor archive script -- runs BEFORE Conductor deletes the workspace
# directory.
#
# Conductor removes the worktree; everything this integration put OUTSIDE the
# worktree is ours to clean up, and without this a month of parallel work
# leaves behind a pile of databases, snapshot tarballs and bare mirrors that
# nothing will ever look at again.
#
# Deletes exactly four things, all of them keyed to this workspace's id:
#   - the workspace's Postgres database
#   - the workspace's data dir (mirrors, snapshots, job specs, gateway socket)
#   - its Docker workspace volumes and any container still labelled with it
#   - its port reservations
#
# Never touches the shared Postgres server, the shared pgdata volume, the
# shared agent image or the shared package-manager cache.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=./lib.sh
source "${script_dir}/lib.sh"

WS_ID="$(workspace_id)"
DATA_DIR="$(workspace_data_dir)"
DB_NAME="$(workspace_db_name)"

echo "conductor: tearing down workspace ${WS_ID}"

# --- database ---------------------------------------------------------------
#
# Refuse anything that is not one of ours. This script runs unattended and a
# DROP DATABASE aimed at the wrong name is not recoverable.
case "${DB_NAME}" in
  codexclone_*) ;;
  *) echo "conductor: refusing to drop '${DB_NAME}': not a codexclone_* database" >&2; exit 1 ;;
esac

TASK_IDS=""
if [ -n "$(postgres_container)" ]; then
  # Read the task ids BEFORE dropping the database. Sandbox containers and
  # `ws-*` volumes are named from task ids, which are random UUIDs -- so they
  # never COLLIDE across workspaces, and none of the Docker naming needs
  # changing. But they do accumulate, and the database is the only thing that
  # knows which ones were ours. Drop it first and they are unattributable
  # forever.
  TASK_IDS="$(docker exec -i "$(postgres_container)" \
    psql -tA -U codex -d "${DB_NAME}" -c 'SELECT id FROM tasks' 2>/dev/null || true)"

  # WITH (FORCE) terminates leftover connections; a worker that outlived the
  # workspace would otherwise block the drop indefinitely.
  if psql_admin -c "DROP DATABASE IF EXISTS \"${DB_NAME}\" WITH (FORCE)" >/dev/null 2>&1; then
    echo "conductor: dropped database ${DB_NAME}"
  else
    echo "conductor: could not drop ${DB_NAME}; drop it by hand if it matters" >&2
  fi
else
  echo "conductor: Postgres is not running; leaving ${DB_NAME} in place" >&2
fi

# --- docker -----------------------------------------------------------------
if docker info >/dev/null 2>&1; then
  for task_id in ${TASK_IDS}; do
    for cid in $(docker ps -aq --filter "label=com.codex-clone.task-id=${task_id}"); do
      docker rm -f "${cid}" >/dev/null 2>&1 || true
      echo "conductor: removed container ${cid:0:12}"
    done
    if docker volume inspect "ws-${task_id}" >/dev/null 2>&1; then
      docker volume rm -f "ws-${task_id}" >/dev/null 2>&1 || true
      echo "conductor: removed volume ws-${task_id}"
    fi
  done
  # Belt and braces for anything created after the workspace label landed.
  for cid in $(docker ps -aq --filter "label=com.codex-clone.workspace=${WS_ID}"); do
    docker rm -f "${cid}" >/dev/null 2>&1 || true
  done
  for vol in $(docker volume ls -q --filter "label=com.codex-clone.workspace=${WS_ID}"); do
    docker volume rm -f "${vol}" >/dev/null 2>&1 || true
  done
fi

# --- data dir ---------------------------------------------------------------
case "${DATA_DIR}" in
  "${HOME}"/.codexclone/workspaces/?*)
    rm -rf "${DATA_DIR}"
    echo "conductor: removed ${DATA_DIR}"
    ;;
  *)
    echo "conductor: refusing to remove '${DATA_DIR}': not under ~/.codexclone/workspaces" >&2
    ;;
esac

# --- ports ------------------------------------------------------------------
release_ports
echo "conductor: released port reservations"
