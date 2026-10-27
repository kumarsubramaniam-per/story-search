#!/usr/bin/env bash
# Stop the local environment: Milvus containers, then quit Docker Desktop to free memory.
# Data in volumes/ is kept.
# Usage: ./scripts/dev-down.sh               stop Milvus and quit Docker Desktop
#        ./scripts/dev-down.sh --keep-docker stop Milvus, leave Docker running
set -euo pipefail
cd "$(dirname "$0")/.."   # always run from the repo root

if docker info >/dev/null 2>&1; then
  echo "Stopping Milvus..."
  docker compose stop
else
  echo "Docker is not running; nothing to stop."
  exit 0
fi

if [ "${1:-}" != "--keep-docker" ]; then
  echo "Quitting Docker Desktop..."
  osascript -e 'quit app "Docker"'
fi

echo "Done. Data in volumes/ is kept; run ./scripts/dev-up.sh to start again."
