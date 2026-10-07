#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$script_dir/.."
if [[ "${1:-}" == --help || "${1:-}" == -h ]]; then
  printf 'Start the human-directed Web UI: scripts/run.sh [--host ADDRESS] [--port PORT]\nAgent-directed launch: bun cli.ts launch --preset NAME [flags]\n'
  exit 0
fi
exec bun cli.ts serve "$@"
