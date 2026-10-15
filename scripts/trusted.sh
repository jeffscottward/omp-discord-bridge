#!/usr/bin/env bash
# Turn Discord trusted mode on/off as ONE switch (flag file + passwordless sudo drop-in).
# off: removes the sudoers drop-in FIRST (so password approvals in gate/approve.ts work again),
#      then the flag. on: installs the drop-in (visudo-checked), then the flag.
# Usage: scripts/trusted.sh on|off|status
set -euo pipefail
FLAG="$HOME/.config/omp-discord/trusted"
SUDOERS=/etc/sudoers.d/90-omp-discord-trusted
USER_NAME="$(id -un)"

status() {
  local f=off s=off
  [ -e "$FLAG" ] && f=on
  sudo -n test -e "$SUDOERS" 2>/dev/null && s=on || { [ "$(sudo -n true 2>/dev/null && echo y)" = y ] && s="unknown(sudo passwordless)"; }
  echo "flag=$f sudoers=$s"
}

case "${1:-status}" in
  on)
    tmp="$(mktemp)"
    printf '%s ALL=(ALL) NOPASSWD: ALL\n' "$USER_NAME" >"$tmp"
    sudo visudo -cf "$tmp" >/dev/null
    sudo install -m 0440 -o root -g root "$tmp" "$SUDOERS"
    rm -f "$tmp"
    mkdir -p "$(dirname "$FLAG")" && touch "$FLAG"
    status
    ;;
  off)
    sudo rm -f "$SUDOERS"
    sudo -k
    rm -f "$FLAG"
    if sudo -n true 2>/dev/null; then
      echo "WARNING: sudo is still passwordless (another sudoers rule?). Password approvals stay refused." >&2
      exit 2
    fi
    status
    ;;
  status) status ;;
  *) echo "usage: $0 on|off|status" >&2; exit 64 ;;
esac
