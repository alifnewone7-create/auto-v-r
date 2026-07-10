#!/usr/bin/env bash
# Start a single compiled worker (use the supervisor for multi-shard runs).
# Runs the sourceless .pyc package - no .py source is needed on this machine.
set -euo pipefail
cd "$(dirname "$0")"

PYTHON="${PYTHON:-python3}"

exec "$PYTHON" -m agent.worker "$@"
