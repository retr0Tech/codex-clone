# syntax=docker/dockerfile:1
#
# The agent sandbox image.
#
# Every task gets a container from this image. It holds no credentials, runs as
# a non-root user, and its entrypoint is the agent runtime, which speaks NDJSON
# on stdout and reaches OpenAI only through the host gateway socket.
#
# Build with `pnpm agent:build`: the runtime is bundled to a single file on the
# host first, so this image needs no package manager, no lockfile, and no
# workspace layout -- which keeps it small and keeps the dependency
# supply-chain surface inside the container at zero.
#
# Version pinning: the base image is pinned by digest and every apt package by
# exact version, so a rebuild produces the same tools rather than whatever
# Debian shipped today. Debian drops superseded versions from the archive, so
# refreshing these pins is a deliberate, reviewable commit. (Production would
# point at a snapshot.debian.org mirror to make that reproducible for good.)
FROM node:22.23.2-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436

ARG AGENT_UID=10001
ARG AGENT_GID=10001

# git      - the workspace is a real checkout; the host derives diffs from it
# ripgrep  - backs the `grep` tool: gitignore-aware and fast on a large repo
# python3  - the second-most-common ecosystem a task will land in
# ca-certificates - package-registry egress over TLS during the setup phase
RUN set -eux; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install --no-install-recommends -y \
        ca-certificates=20250419~deb12u1 \
        git=1:2.39.5-0+deb12u3 \
        ripgrep=13.0.0-4+b2 \
        python3=3.11.2-1+b1; \
    rm -rf /var/lib/apt/lists/*; \
    git --version; rg --version; python3 --version

# Non-root, with the uid pinned numerically because the provider sets
# `User: 10001:10001` explicitly rather than trusting the image default.
# The uid must match AGENT_UID in packages/sandbox-docker/src/container-config.ts.
RUN set -eux; \
    groupadd --gid "${AGENT_GID}" agent; \
    useradd --uid "${AGENT_UID}" --gid "${AGENT_GID}" --home-dir /tmp --shell /bin/bash --no-create-home agent

# /workspace is the mount point for the hot volume. Creating it here owned by
# `agent` matters: Docker seeds a fresh named volume from the image directory,
# ownership included, so the first turn of a new task can write without a chown.
# /cache is the shared package-manager cache volume.
RUN set -eux; \
    mkdir -p /workspace /cache /opt/agent; \
    chown "${AGENT_UID}:${AGENT_GID}" /workspace /cache

# The runtime: one bundled file, no node_modules, no install step.
COPY --chown=root:root apps/agent-runtime/dist/agent.mjs /opt/agent/agent.mjs

USER ${AGENT_UID}:${AGENT_GID}
WORKDIR /workspace

# The root filesystem is mounted read-only and /tmp is a tmpfs, so HOME must
# point somewhere writable or git and npm fail before the agent starts.
ENV HOME=/tmp \
    NODE_ENV=production \
    AGENT_JOB_SPEC_PATH=/run/job.json \
    AGENT_GATEWAY_SOCKET=/run/gateway.sock

# Note what is NOT here: no OPENAI_API_KEY, no GITHUB_TOKEN, no DATABASE_URL.
# The job spec arrives as a bind-mounted file at /run/job.json, and model calls
# go to a unix socket at /run/gateway.sock that the host owns.
ENTRYPOINT ["node", "--enable-source-maps", "/opt/agent/agent.mjs"]
