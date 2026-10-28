#!/usr/bin/env bash
# Boots a private Ether for verification: fresh build, throwaway data dir, free ports,
# an admin account made through the operator CLI. Never touches ./data, :3000 or :2222.
# Usage: launch.sh [--no-build]
# Prints the run's state.env; every other helper reads it.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
cd "$ROOT"

RUN_ID="$(date +%Y%m%d-%H%M%S)-$$"
RUN_DIR="$ROOT/e2e-report/verify/$RUN_ID"
mkdir -p "$RUN_DIR/evidence"

if [[ "${1:-}" != "--no-build" ]]; then
  echo "building web app (log: $RUN_DIR/build.log)" >&2
  bun run build >"$RUN_DIR/build.log" 2>&1 || { echo "build failed, see $RUN_DIR/build.log" >&2; exit 1; }
fi
[[ -f dist/client/_shell.html ]] || { echo "dist/client/_shell.html missing; run without --no-build" >&2; exit 1; }

ADMIN_USER=admin
ADMIN_PASSWORD=admin-password-1
free_port() { bun -e 'const s=Bun.listen({hostname:"127.0.0.1",port:0,socket:{data(){}}});console.log(s.port);s.stop(true)'; }

# One server on a fresh data dir. Returns 0 ready, 1 failed, 2 hit the ssh2 host-key flake, 3 timed out.
start_once() {
  # No trailing slash: the server hashes the normalized path into CI container labels.
  local tmp="${TMPDIR:-/tmp}"
  DATA="$(mktemp -d "${tmp%/}/ether-verify-XXXXXX")"
  # Serve a snapshot of the build so a rebuild during the run can't change what's served.
  cp -R dist/client "$DATA/web"
  PORT="$(free_port)"
  SSH_PORT="$(free_port)"
  while [[ "$SSH_PORT" == "$PORT" ]]; do SSH_PORT="$(free_port)"; done
  export ETHER_DATA="$DATA" ETHER_HOST=127.0.0.1 ETHER_PORT="$PORT" ETHER_SSH_PORT="$SSH_PORT" ETHER_WEB_DIST="$DATA/web"
  unset ETHER_PUBLIC_URL ETHER_SSH_HOST BETTER_AUTH_SECRET

  if ! bun src/server/cli.ts create-admin "$ADMIN_USER" --password "$ADMIN_PASSWORD" >"$RUN_DIR/create-admin.log" 2>&1; then
    echo "create-admin failed, see $RUN_DIR/create-admin.log" >&2
    rm -rf "$DATA"
    return 1
  fi

  nohup bun src/server/main.ts >"$RUN_DIR/server.log" 2>&1 &
  PID=$!
  URL="http://127.0.0.1:$PORT"
  {
    echo "RUN_ID=$RUN_ID"
    echo "RUN_DIR=$RUN_DIR"
    echo "EVIDENCE_DIR=$RUN_DIR/evidence"
    echo "ETHER_URL=$URL"
    echo "ETHER_PORT=$PORT"
    echo "ETHER_SSH_PORT=$SSH_PORT"
    echo "ETHER_DATA=$DATA"
    echo "PID=$PID"
    echo "ADMIN_USER=$ADMIN_USER"
    echo "ADMIN_PASSWORD=$ADMIN_PASSWORD"
    echo "SOURCE_REV=$(git rev-parse --short HEAD)"
    echo "SOURCE_FINGERPRINT=$({ git diff HEAD; git ls-files --others --exclude-standard -z | xargs -0 shasum 2>/dev/null; } | shasum | cut -c1-12)"
  } >"$RUN_DIR/state.env"
  ln -sfn "$RUN_ID" "$ROOT/e2e-report/verify/latest"

  for _ in $(seq 1 100); do
    if ! kill -0 "$PID" 2>/dev/null; then
      cp "$RUN_DIR/server.log" "$RUN_DIR/server-failed-start.log"
      rm -rf "$DATA"
      grep -q "Malformed OpenSSH private key" "$RUN_DIR/server.log" && return 2
      echo "server exited early; tail of $RUN_DIR/server.log:" >&2
      tail -20 "$RUN_DIR/server.log" >&2
      return 1
    fi
    curl -fsS "$URL/api/health" >/dev/null 2>&1 && return 0
    sleep 0.2
  done
  return 3
}

for attempt in 1 2; do
  rc=0
  start_once || rc=$?
  if [[ $rc == 0 ]]; then
    echo "ready: $URL (ssh :$SSH_PORT, pid $PID)" >&2
    cat "$RUN_DIR/state.env"
    exit 0
  fi
  if [[ $rc == 2 && $attempt == 1 ]]; then
    # Product bug, not a verification failure: ssh2's generateKeyPairSync("ed25519") sometimes
    # writes a host key its own parseKey rejects (about 1 in 200 fresh data dirs).
    echo "WARNING: server crashed on a malformed generated SSH host key (known ssh2 flake, log in $RUN_DIR/server-failed-start.log); retrying with a fresh data dir" >&2
    continue
  fi
  if [[ $rc == 3 ]]; then
    # The server is still alive but not healthy; stop it so a failed launch leaves nothing running.
    echo "server did not answer /api/health within 20s; stopping it (logs kept in $RUN_DIR)" >&2
    "$ROOT/.claude/skills/verify-ether/scripts/cleanup.sh" "$RUN_DIR" >&2
  fi
  exit 1
done
exit 1
