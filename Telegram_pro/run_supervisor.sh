#!/usr/bin/env bash
# Start the compiled agent supervisor (spawns + auto-restarts worker shards).
# Runs the sourceless .pyc package - no .py source is needed on this machine.
set -euo pipefail
cd "$(dirname "$0")"

# Use python3.12 (or 3.11). Do NOT use 3.13/3.14 - py-tgcalls is unstable there.
PYTHON="${PYTHON:-python3}"

exec "$PYTHON" -m agent.supervisor "$@"
