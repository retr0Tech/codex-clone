#!/usr/bin/env bash
#
# Builds the agent sandbox image.
#
# Two steps, in this order, because the image deliberately contains no package
# manager: the runtime is bundled to a single file on the host, and the image
# just copies it in.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE="${AGENT_IMAGE:-codex-clone/agent:dev}"

# Docker Desktop creates a PER-USER socket. If another macOS account installed
# Docker first, /var/run/docker.sock is a symlink into that user's home and is
# not readable here -- which is why the socket is addressed explicitly rather
# than left to the default.
DOCKER_SOCKET="${DOCKER_SOCKET:-$HOME/.docker/run/docker.sock}"
if [[ ! -S "$DOCKER_SOCKET" ]]; then
  echo "error: no docker socket at $DOCKER_SOCKET" >&2
  echo "       start Docker Desktop under this account, or set DOCKER_SOCKET." >&2
  exit 1
fi
export DOCKER_HOST="unix://${DOCKER_SOCKET}"

echo "==> bundling agent runtime"
cd "$REPO_ROOT"
pnpm --filter agent-runtime run build

BUNDLE="$REPO_ROOT/apps/agent-runtime/dist/agent.mjs"
[[ -f "$BUNDLE" ]] || { echo "error: bundle not produced at $BUNDLE" >&2; exit 1; }
echo "    $(wc -c < "$BUNDLE" | tr -d ' ') bytes"

echo "==> building $IMAGE"
# Build context is the repo root so the Dockerfile can COPY the bundle, but
# .dockerignore keeps the context to just that file.
docker build \
  --file "$REPO_ROOT/docker/agent/Dockerfile" \
  --tag "$IMAGE" \
  "$REPO_ROOT"

echo "==> done"
docker image inspect "$IMAGE" --format '    {{.RepoTags}} {{.Size}} bytes  user={{.Config.User}}'
