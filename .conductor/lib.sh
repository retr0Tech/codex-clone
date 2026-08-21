#!/usr/bin/env bash
# Shared helpers for the Conductor setup / run / archive scripts.
#
# Sourced, never executed. Every function here is safe to call twice: Conductor
# re-runs the setup script on demand, and a half-finished workspace has to be
# repairable by running it again rather than by being deleted.

# --- workspace identity -----------------------------------------------------

# The directory this workspace lives in. Conductor exports CONDUCTOR_WORKSPACE_PATH;
# outside Conductor we ask git, so a plain `git worktree add` gets the same
# treatment as a Conductor workspace.
workspace_path() {
  if [ -n "${CONDUCTOR_WORKSPACE_PATH:-}" ]; then
    printf '%s\n' "${CONDUCTOR_WORKSPACE_PATH}"
    return
  fi
  git rev-parse --show-toplevel
}

# The ORIGINAL checkout, not this worktree.
#
# CONDUCTOR_ROOT_PATH is Conductor's name for it. Outside Conductor we derive it
# from the shared git directory: in a linked worktree `--git-common-dir` points
# at the main checkout's `.git`, so its parent is the main checkout. This is how
# a workspace finds the parent's APP_ENCRYPTION_KEY.
repo_root_path() {
  if [ -n "${CONDUCTOR_ROOT_PATH:-}" ]; then
    printf '%s\n' "${CONDUCTOR_ROOT_PATH}"
    return
  fi
  local common
  common="$(cd "$(git rev-parse --git-common-dir)" && pwd -P)"
  dirname "${common}"
}

# A short, stable, filesystem- and Postgres-safe id for this workspace.
#
# The name is what a human reads; the six hex characters are what make it
# unique. Conductor workspace names are unique within a repository but two
# unrelated checkouts can both be called `main`, and a database silently shared
# between them is exactly the failure this whole integration exists to prevent.
# The suffix is a disambiguator on a NAME, never on a port -- see reserve_port.
workspace_id() {
  local name path slug hash
  path="$(cd "$(workspace_path)" && pwd -P)"
  name="${CONDUCTOR_WORKSPACE_NAME:-$(basename "${path}")}"

  # Lowercase, non-alphanumerics to underscore, collapse and trim them.
  slug="$(printf '%s' "${name}" |
    tr '[:upper:]' '[:lower:]' |
    sed -e 's/[^a-z0-9]\{1,\}/_/g' -e 's/^_*//' -e 's/_*$//')"
  [ -n "${slug}" ] || slug="workspace"
  # Postgres identifiers cap at 63 bytes and `codexclone_` + `_` + 6 eats 18.
  slug="$(printf '%s' "${slug}" | cut -c1-40)"

  hash="$(printf '%s' "${path}" | shasum -a 256 | cut -c1-6)"
  printf '%s_%s\n' "${slug}" "${hash}"
}

# Everything this integration keeps outside the workspace directory. The archive
# script deletes exactly this and nothing else.
state_root() {
  printf '%s/.codexclone/conductor\n' "${HOME}"
}

# Host-side agent state for ONE workspace: bare mirrors, cold snapshots, job
# specs, and the model-gateway unix socket. Two workers sharing a gateway socket
# path is a hard conflict -- whichever bound it second loses -- so this is not
# an optional nicety.
workspace_data_dir() {
  printf '%s/.codexclone/workspaces/%s\n' "${HOME}" "$(workspace_id)"
}

workspace_db_name() {
  printf 'codexclone_%s\n' "$(workspace_id)"
}

# --- .env.local -------------------------------------------------------------

# Reads one key out of a dotenv file. Blank counts as absent, matching
# apps/worker/src/config.ts, where an empty value is treated as unset.
env_file_get() {
  local file="$1" key="$2" line value
  [ -f "${file}" ] || return 0
  line="$(grep -E "^[[:space:]]*${key}=" "${file}" | tail -n 1 || true)"
  [ -n "${line}" ] || return 0
  value="${line#*=}"
  # Strip surrounding quotes the same way apps/web/next.config.ts does.
  value="$(printf '%s' "${value}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  case "${value}" in
    \"*\") value="${value:1:${#value}-2}" ;;
    \'*\') value="${value:1:${#value}-2}" ;;
  esac
  printf '%s\n' "${value}"
}

# Set KEY=value in a dotenv file, replacing an existing assignment in place and
# otherwise appending. Rewriting the whole file would throw away anything the
# developer added by hand, and setup runs more than once.
env_file_set() {
  local file="$1" key="$2" value="$3" tmp
  touch "${file}"
  tmp="$(mktemp "${file}.XXXXXX")"
  KEY="${key}" VALUE="${value}" awk '
    BEGIN { key = ENVIRON["KEY"]; value = ENVIRON["VALUE"]; done = 0 }
    {
      if ($0 ~ "^[[:space:]]*" key "=") {
        if (!done) { print key "=" value; done = 1 }
      } else {
        print
      }
    }
    END { if (!done) print key "=" value }
  ' "${file}" >"${tmp}"
  mv "${tmp}" "${file}"
  chmod 600 "${file}"
}

# Export every assignment in a dotenv file into the current shell.
#
# The npm scripts need WEB_PORT before Node ever starts (`next dev -p
# ${WEB_PORT:-3000}` is expanded by the shell that runs the script), so reading
# .env.local inside the process is too late.
load_env_file() {
  local file="$1" line key value
  [ -f "${file}" ] || return 0
  while IFS= read -r line || [ -n "${line}" ]; do
    case "${line}" in ''|'#'*) continue ;; esac
    case "${line}" in *=*) ;; *) continue ;; esac
    key="${line%%=*}"
    key="$(printf '%s' "${key}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    [ -n "${key}" ] || continue
    value="${line#*=}"
    value="$(printf '%s' "${value}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    case "${value}" in
      \"*\") value="${value:1:${#value}-2}" ;;
      \'*\') value="${value:1:${#value}-2}" ;;
    esac
    export "${key}=${value}"
  done <"${file}"
}

# --- ports ------------------------------------------------------------------

# Is anything listening on this TCP port right now?
port_is_listening() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1 && return 0
  fi
  if command -v nc >/dev/null 2>&1; then
    nc -z 127.0.0.1 "${port}" >/dev/null 2>&1 && return 0
  fi
  return 1
}

port_registry() {
  printf '%s/ports\n' "$(state_root)"
}

# Allocate a TCP port to this workspace, and REMEMBER that we did.
#
#   reserve_port <role> <preferred-or-empty> <range-start> <range-end>
#
# Deliberately not a hash of the workspace name. A hash collides eventually and
# the resulting failure -- two workspaces, one port, whichever bound it first
# wins -- is baffling to debug. Instead each candidate port is claimed by
# `mkdir`, which is atomic on every filesystem we care about, so two setups
# racing cannot both believe they own 3001. A listening socket is not enough on
# its own: a workspace that has been set up but is not running holds no socket,
# and the next workspace would happily take its port.
#
# Reservations left by a workspace whose directory no longer exists are
# reclaimed, so a `rm -rf`d worktree does not leak a port forever.
reserve_port() {
  local role="$1" preferred="$2" range_start="$3" range_end="$4"
  local id registry dir owner_file owner candidates port
  id="$(workspace_id)"
  registry="$(port_registry)"
  mkdir -p "${registry}"

  candidates=""
  [ -n "${preferred}" ] && candidates="${preferred}"
  for port in $(seq "${range_start}" "${range_end}"); do
    candidates="${candidates} ${port}"
  done

  for port in ${candidates}; do
    dir="${registry}/${port}"
    owner_file="${dir}/owner"

    if mkdir "${dir}" 2>/dev/null; then
      # We now own the reservation. Only keep it if nothing unrelated is
      # already listening there.
      if port_is_listening "${port}"; then
        rm -rf "${dir}"
        continue
      fi
      printf '%s\n%s\n%s\n' "${id}" "$(workspace_path)" "${role}" >"${owner_file}"
      printf '%s\n' "${port}"
      return 0
    fi

    owner="$(head -n 1 "${owner_file}" 2>/dev/null || true)"
    if [ "${owner}" = "${id}" ]; then
      # Ours from a previous setup run, for this role.
      if [ "$(sed -n '3p' "${owner_file}" 2>/dev/null || true)" = "${role}" ]; then
        printf '%s\n' "${port}"
        return 0
      fi
      continue
    fi

    # Someone else's -- unless their workspace is gone, in which case reclaim.
    local owner_path
    owner_path="$(sed -n '2p' "${owner_file}" 2>/dev/null || true)"
    if [ -n "${owner_path}" ] && [ ! -d "${owner_path}" ] && ! port_is_listening "${port}"; then
      printf '%s\n%s\n%s\n' "${id}" "$(workspace_path)" "${role}" >"${owner_file}"
      printf '%s\n' "${port}"
      return 0
    fi
  done

  echo "conductor: no free ${role} port in ${range_start}-${range_end}" >&2
  return 1
}

# Hand back every port this workspace holds. Called by the archive script.
release_ports() {
  local id registry dir
  id="$(workspace_id)"
  registry="$(port_registry)"
  [ -d "${registry}" ] || return 0
  for dir in "${registry}"/*; do
    [ -d "${dir}" ] || continue
    if [ "$(head -n 1 "${dir}/owner" 2>/dev/null || true)" = "${id}" ]; then
      rm -rf "${dir}"
    fi
  done
}

# --- postgres ---------------------------------------------------------------

# docker-compose.yml pins `name: codex-clone`, so every worktree addresses the
# SAME Postgres container. That is the point: one server, one port, one data
# volume, and a separate DATABASE per workspace. Bringing up a second server per
# workspace would need a second port and would not isolate anything that this
# does not already isolate.
COMPOSE_PROJECT="codex-clone"

postgres_container() {
  docker ps --filter "label=com.docker.compose.project=${COMPOSE_PROJECT}" \
    --filter "label=com.docker.compose.service=postgres" \
    --format '{{.Names}}' 2>/dev/null | head -n 1
}

# Start the shared Postgres only if it is not already up.
#
# `docker compose up -d` from a second worktree would be a no-op in the happy
# case, but it is a no-op that CAN decide to recreate the container -- and
# restarting Postgres underneath a sibling workspace that is mid-run is exactly
# the interference this integration promises not to cause.
ensure_postgres() {
  local name
  name="$(postgres_container)"
  if [ -n "${name}" ]; then
    printf '%s\n' "${name}"
    return 0
  fi
  echo "conductor: starting the shared Postgres container" >&2
  docker compose up -d postgres >&2
  local i
  for i in $(seq 1 60); do
    name="$(postgres_container)"
    if [ -n "${name}" ] && docker exec "${name}" pg_isready -U codex >/dev/null 2>&1; then
      printf '%s\n' "${name}"
      return 0
    fi
    sleep 1
  done
  echo "conductor: Postgres did not become ready; is Docker Desktop running?" >&2
  return 1
}

psql_admin() {
  local container
  container="$(postgres_container)"
  [ -n "${container}" ] || { echo "conductor: the shared Postgres container is not running" >&2; return 1; }
  docker exec -i "${container}" psql -v ON_ERROR_STOP=1 -U codex -d postgres "$@"
}
