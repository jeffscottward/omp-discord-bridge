#!/usr/bin/env bash
# Wait until the bridge is idle, then scripts/safe-restart.sh, with Discord notices before and after.
# Idle = no running or queued job, no reply still being posted, owner not in the voice call (no time limit).
# The queue lives only in memory, so a restart with queued jobs would lose them.
# Lets a Discord run restart its own bridge without killing itself before its answer is posted.
# Usage: scripts/restart-when-idle.sh [rev] [timeout]   (run detached, e.g. via systemd-run --user)
set -uo pipefail
cd "$(dirname "$0")/.."
# Single flight: a newer waiter replaces nothing; extra waiters exit at once.
exec 9>"${XDG_RUNTIME_DIR:-/tmp}/omp-discord-restart.lock"
flock -n 9 || { echo "another restart waiter is active; exiting"; exit 0; }
PORT="${OMP_BOT_HTTP_PORT:-47821}"
# Owner 2026-10-15: restart notices are framed by rule lines with a 🤖 header, so they stand apart in the chat.
RULE="━━━━━━━━━━━━━━━━━━━━"
notify() { bun scripts/notify-owner.ts "$(printf "%s\n🤖 **Bot restart**\n———————————\n%s\n%s" "$RULE" "$1" "$RULE")" || true; }
# "Restarting now" + its result read as one block: the first has no bottom rule, the second no top rule.
notify_open() { bun scripts/notify-owner.ts "$(printf "%s\n🤖 **Bot restart**\n———————————\n%s" "$RULE" "$1")" || true; }
notify_close() { bun scripts/notify-owner.ts "$(printf "%s\n%s" "$1" "$RULE")" || true; }
sleep 20
health() { curl -fsS --max-time 3 "http://127.0.0.1:$PORT/health" 2>/dev/null; }
# Owner 2026-10-14: never restart during a voice call or a running job, however long that takes
# (the old 2 h give-up restarted mid-call). One Discord notice if the wait passes 10 minutes.
waited=0; told=0; down=0
while :; do
  if h="$(health)"; then
    down=0
    # Older builds have no "finishing"/"boards" field: treat a missing field as 0.
    # "boards" = queue-message reprints still pending (the final 🏁 Finished post runs 1.5 s after the last answer).
    # Require an empty queue too: the next job starts in the same ms the last one ends, but one poll can land in that gap.
    grep -q '"running":\[\]' <<<"$h" && grep -q '"queued":\[\]' <<<"$h" && ! grep -qE '"finishing":[1-9]' <<<"$h" && ! grep -qE '"boards":[1-9]' <<<"$h" && ! grep -q '"voice":true' <<<"$h" && break
    if [ "$told" = 0 ] && [ "$waited" -ge 600 ]; then
      why="a job is still running or waiting"; grep -q '"voice":true' <<<"$h" && why="you are in 🎧 OMP Voice"
      notify "🕓 **Bot restart pending** (new code is ready). Waiting because $why; it restarts as soon as that ends."
      told=1
    fi
  else
    down=$((down + 1))  # bridge unreachable: no call or job to protect; restart after ~3 min
    [ "$down" -ge 18 ] && break
  fi
  sleep 10; waited=$((waited + 10))
done
OLD="$(git rev-parse --short HEAD)"
notify_open "🔄 **Restarting the bot now** (loading \`$OLD\`). Please wait for ✅ before you send messages or join 🎧 OMP Voice."
START=$(date +%s)
out="$(scripts/safe-restart.sh "${1:-HEAD}" "${2:-60}" 2>&1)"; rc=$?
echo "$out"
secs=$(( $(date +%s) - START ))
case $rc in
  0) notify_close "✅ **Restart done** in ${secs}s. The bot is running \`$(git rev-parse --short HEAD)\`. You can send messages and join voice now." ;;
  1) notify_close "⚠️ **Restart failed; the change was reverted.** The bot is back up at \`$(git rev-parse --short HEAD)\` with trusted mode off." ;;
  *) notify_close "❌ **Restart failed and the bot is still down.** It needs a manual fix on the rig." ;;
esac
exit $rc
