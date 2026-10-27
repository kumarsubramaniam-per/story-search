#!/usr/bin/env bash
# Start the local environment: Docker Desktop (if needed) + Milvus Standalone.
# Usage: ./scripts/dev-up.sh   (or: npm run dev:up)
set -euo pipefail
cd "$(dirname "$0")/.."   # always run from the repo root

# 1. Make sure Docker is running (macOS: launch Docker Desktop if needed)
if ! docker info >/dev/null 2>&1; then
  echo "Starting Docker Desktop..."
  open -a Docker
  for _ in $(seq 1 60); do
    docker info >/dev/null 2>&1 && break
    sleep 2
  done
  if ! docker info >/dev/null 2>&1; then
    echo "Docker did not start within 2 minutes. Open Docker Desktop manually and retry."
    exit 1
  fi
fi
echo "Docker is running."

# 2. Start Milvus (etcd + minio + standalone)
docker compose up -d

# 3. Wait until Milvus reports healthy
echo "Waiting for Milvus to become healthy..."
container_id=$(docker compose ps -q standalone)
status="starting"
for _ in $(seq 1 60); do
  status=$(docker inspect -f '{{.State.Health.Status}}' "$container_id" 2>/dev/null || echo "starting")
  [ "$status" = "healthy" ] && break
  sleep 3
done

docker compose ps
if [ "$status" = "healthy" ]; then
  echo "Milvus is ready on localhost:19530"
else
  echo "Milvus is not healthy yet (status: $status). Check: docker compose logs standalone"
  exit 1
fi
