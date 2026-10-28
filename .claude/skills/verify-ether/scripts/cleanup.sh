#!/usr/bin/env bash
# Stops the server this run started, removes its CI containers and data dir.
# Keeps $RUN_DIR (evidence/, server.log, state.env) as the proof.
# Usage: cleanup.sh [run-dir]   (default: e2e-report/verify/latest)
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
RUN_DIR="$(cd "${1:-$ROOT/e2e-report/verify/latest}" && pwd -P)"
[[ -f "$RUN_DIR/state.env" ]] || { echo "no state.env in $RUN_DIR"; exit 1; }
# shellcheck disable=SC1091
source "$RUN_DIR/state.env"

cmd="$(ps -o command= -p "$PID" 2>/dev/null || true)"
if [[ "$cmd" == *"src/server/main.ts"* ]]; then
  kill -TERM "$PID"
  for _ in $(seq 1 50); do kill -0 "$PID" 2>/dev/null || break; sleep 0.2; done
  kill -0 "$PID" 2>/dev/null && kill -KILL "$PID"
  echo "stopped pid $PID"
elif [[ -n "$cmd" ]]; then
  echo "pid $PID is now '$cmd', not ours; left it alone"
else
  echo "pid $PID already gone"
fi

# CI job containers are labelled with a hash of the data dir; remove only ours.
label="$(printf %s "$ETHER_DATA" | shasum -a 256 | cut -c1-16)"
for rt in docker podman; do
  command -v "$rt" >/dev/null || continue
  ids="$("$rt" ps -aq --filter "label=ether.ci.instance=$label" 2>/dev/null || true)"
  [[ -n "$ids" ]] && "$rt" rm -f $ids >/dev/null && echo "removed $rt containers: $ids"
done

if [[ "$ETHER_DATA" == *ether-verify-* && -d "$ETHER_DATA" ]]; then
  rm -rf "$ETHER_DATA" && echo "removed $ETHER_DATA"
fi
echo "STOPPED_AT=$(date -u +%FT%TZ)" >>"$RUN_DIR/state.env"
echo "evidence kept: $RUN_DIR"
