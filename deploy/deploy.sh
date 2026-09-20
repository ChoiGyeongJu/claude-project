#!/usr/bin/env bash
# Installed on the VM at /usr/local/bin/deploy.sh.
#
# Pulls the worker image and replaces the running container with it.
# Safe to re-run: it tears down whatever container is already running
# (if any) before starting the new one, so re-running after a failure,
# or running it twice in a row, converges on the same end state instead
# of erroring out or leaving two containers behind.
#
# Usage:
#   deploy.sh            # deploy :latest (what CI's deploy job calls)
#   deploy.sh <tag>       # deploy a specific tag, e.g. a commit SHA for
#                          # a manual rollback — see docs/deploy-oci.md
set -euo pipefail

IMAGE="ghcr.io/choigyeongju/market-radar"
TAG="${1:-latest}"
CONTAINER_NAME="market-radar-worker"
ENV_FILE="/home/ubuntu/worker.env"

# --- Memory limit -----------------------------------------------------
# The box has 954MB RAM and another container (trading-trader) already
# holds ~495MB, leaving ~459MB free. 256m gives this Node worker room
# for normal heap + GC headroom while still leaving ~200MB of slack for
# the OS, the Docker daemon itself, and the neighbour's own fluctuation.
# --memory-swap == --memory disables *additional* swap for this
# container specifically: a worker that outgrows 256m almost certainly
# has a leak, and OOM-killing it (Docker restarts it via --restart
# always) is far better on this box than letting it swap and drag the
# whole VM — including the neighbour's container — into thrashing.
#
# Do not raise this without first checking `free -h` on the VM: raising
# it is exactly how this worker starves trading-trader.
MEMORY_LIMIT="256m"

# --- Log rotation -------------------------------------------------------
# Unbounded `json-file` logs are a real risk on a small, unattended VM
# (45GB disk) that nobody is watching day to day — a noisy failure loop
# could fill the disk before anyone notices. Cap it well below anything
# that matters here: 5 files x 10MB = 50MB max for this container's logs.
LOG_MAX_SIZE="10m"
LOG_MAX_FILES="5"

echo "==> Deploying ${IMAGE}:${TAG}"
docker pull "${IMAGE}:${TAG}"

if docker inspect "${CONTAINER_NAME}" >/dev/null 2>&1; then
  echo "==> Stopping existing container (${CONTAINER_NAME})"
  # Matches --stop-timeout below: the worker finishes an in-flight cycle
  # (Telegram/LLM calls can take longer than Docker's 10s default grace
  # period) before Docker sends SIGKILL. Without this, a cycle killed
  # mid-flight can send a Telegram alert and die before recording it as
  # sent, duplicating that alert on restart. See docs/deploy-oci.md.
  docker stop --time 45 "${CONTAINER_NAME}" >/dev/null
  docker rm "${CONTAINER_NAME}" >/dev/null
fi

echo "==> Starting ${CONTAINER_NAME}"
docker run -d \
  --name "${CONTAINER_NAME}" \
  --restart always \
  --stop-timeout 45 \
  --env-file "${ENV_FILE}" \
  --memory "${MEMORY_LIMIT}" \
  --memory-swap "${MEMORY_LIMIT}" \
  --log-driver json-file \
  --log-opt "max-size=${LOG_MAX_SIZE}" \
  --log-opt "max-file=${LOG_MAX_FILES}" \
  "${IMAGE}:${TAG}"

echo "==> Pruning old, unused images"
docker image prune -af --filter "until=72h" || true

echo "==> Deployed. Current state:"
docker ps --filter "name=${CONTAINER_NAME}"
