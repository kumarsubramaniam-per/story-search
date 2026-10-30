#!/usr/bin/env bash
# Start the local environment: Docker Desktop (if needed) + Milvus Standalone + Elasticsearch.
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

# 2. Start everything in docker-compose.yml: Milvus (etcd + minio + standalone) and Elasticsearch
docker compose up -d

# 3. Wait until each service reports healthy. Usage: wait_healthy <compose service> <label> <tries>
wait_healthy() {
  local container_id status="starting"
  container_id=$(docker compose ps -q "$1")
  echo "Waiting for $2 to become healthy..."
  for _ in $(seq 1 "$3"); do
    status=$(docker inspect -f '{{.State.Health.Status}}' "$container_id" 2>/dev/null || echo "starting")
    [ "$status" = "healthy" ] && break
    sleep 3
  done
  if [ "$status" != "healthy" ]; then
    docker compose ps
    echo "$2 is not healthy yet (status: $status). Check: docker compose logs $1"
    exit 1
  fi
}
wait_healthy standalone Milvus 60
wait_healthy elasticsearch Elasticsearch 40

docker compose ps
echo "Milvus is ready on localhost:19530"
echo "Elasticsearch is ready on localhost:9200"
