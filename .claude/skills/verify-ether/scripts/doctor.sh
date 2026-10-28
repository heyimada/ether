#!/usr/bin/env bash
# Read-only: is this verification instance ours, up, current and signed-in-able?
# Usage: doctor.sh [run-dir]   (default: e2e-report/verify/latest)
# Exit 0 = drive it. Anything else = relaunch, don't drive.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
RUN_DIR="${1:-$ROOT/e2e-report/verify/latest}"
[[ -f "$RUN_DIR/state.env" ]] || { echo "FAIL no state.env in $RUN_DIR; run launch.sh"; exit 1; }
# shellcheck disable=SC1091
source "$RUN_DIR/state.env"
[[ -z "${STOPPED_AT:-}" ]] || { echo "FAIL run was cleaned up at $STOPPED_AT; launch a new one"; exit 1; }

fail=0
ok() { echo "ok   $*"; }
bad() { echo "FAIL $*"; fail=1; }
warn() { echo "warn $*"; }

if kill -0 "$PID" 2>/dev/null; then ok "pid $PID alive"; else bad "pid $PID not running"; fi
cmd="$(ps -o command= -p "$PID" 2>/dev/null || true)"
if [[ "$cmd" == *"src/server/main.ts"* ]]; then ok "pid $PID is '$cmd'"; else bad "pid $PID is not the Ether server ('$cmd')"; fi

listener="$(lsof -nP -iTCP:"$ETHER_PORT" -sTCP:LISTEN -t 2>/dev/null | head -1)"
if [[ "$listener" == "$PID" ]]; then ok "port $ETHER_PORT owned by our pid"; else bad "port $ETHER_PORT owned by '${listener:-nobody}', not $PID; refuse to drive"; fi
ssh_listener="$(lsof -nP -iTCP:"$ETHER_SSH_PORT" -sTCP:LISTEN -t 2>/dev/null | head -1)"
if [[ "$ssh_listener" == "$PID" ]]; then ok "ssh port $ETHER_SSH_PORT owned by our pid"; else bad "ssh port $ETHER_SSH_PORT owned by '${ssh_listener:-nobody}'"; fi

if [[ "$(curl -fsS "$ETHER_URL/api/health" 2>/dev/null)" == *'"ok":true'* ]]; then ok "/api/health"; else bad "/api/health did not answer ok"; fi
code="$(curl -s -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -H "origin: $ETHER_URL" \
  -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASSWORD\"}" "$ETHER_URL/api/auth/sign-in/username")"
if [[ "$code" == 200 ]]; then ok "admin sign-in"; else bad "admin sign-in returned $code"; fi

[[ -d "$ETHER_DATA" && "$ETHER_DATA" == *ether-verify-* ]] && ok "data dir $ETHER_DATA" || bad "data dir $ETHER_DATA missing or not a verify dir"

cd "$ROOT"
[[ "$(git rev-parse --short HEAD)" == "$SOURCE_REV" ]] || warn "HEAD moved since launch ($SOURCE_REV -> $(git rev-parse --short HEAD)); relaunch to verify current code"
[[ "$(git status --porcelain --untracked-files=no | shasum | cut -c1-12)" == "$SOURCE_FINGERPRINT" ]] || warn "tracked files changed since launch; the server and served build are stale, relaunch"

exit $fail
