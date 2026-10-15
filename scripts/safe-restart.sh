#!/usr/bin/env bash
# Restart the bridge with a safety net: if /health does not report ready within the timeout,
# revert the given commit(s), leave trusted mode (flag + sudoers via trusted.sh off), restart again.
# Usage: scripts/safe-restart.sh [<rev-to-revert-on-failure>=HEAD] [timeout-seconds=45]
set -uo pipefail
cd "$(dirname "$0")/.."
REV="${1:-HEAD}"
TIMEOUT="${2:-45}"
UNIT=omp-discord-bot.service
PORT="${OMP_BOT_HTTP_PORT:-47821}"
REV_SHA="$(git rev-parse --verify "$REV^{commit}")" || { echo "bad rev $REV" >&2; exit 64; }

healthy() {
  local deadline=$((SECONDS + TIMEOUT))
  while [ $SECONDS -lt $deadline ]; do
    if systemctl --user is-active --quiet "$UNIT" &&
       curl -fsS --max-time 3 "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q '"ready":[[:space:]]*true'; then
      return 0
    fi
    sleep 2
  done
  return 1
}

systemctl --user restart "$UNIT"
if healthy; then echo "OK: $UNIT healthy at $(git rev-parse --short HEAD)"; exit 0; fi

echo "FAIL: $UNIT not healthy within ${TIMEOUT}s; reverting ${REV_SHA:0:7} and leaving trusted mode" >&2
journalctl --user -u "$UNIT" -n 30 --no-pager >&2 || true
git revert --no-edit "$REV_SHA" || { git revert --abort 2>/dev/null; echo "revert failed; manual fix needed" >&2; }
scripts/trusted.sh off || true
systemctl --user restart "$UNIT"
if healthy; then echo "RECOVERED at $(git rev-parse --short HEAD) (trusted mode off)" >&2; exit 1; fi
echo "STILL UNHEALTHY after revert; manual fix needed" >&2
exit 2
