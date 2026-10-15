#!/usr/bin/env bash
# Prepare hold-music clips for voice calls from a playlist you are allowed to use. For each chosen video:
# resolve the audio URL with yt-dlp, cut a 10-minute clip with ffmpeg (HTTP range seek), lower the
# volume, and encode 48 kHz stereo Ogg Opus into $STATE/hold-music/ready/. Re-run to refresh.
# Usage: scripts/hold-music.sh <playlist url> [title regex]   (or HOLD_MUSIC_PLAYLIST / HOLD_MUSIC_PICK)
# Any *.ogg files you put in $STATE/hold-music/ready/ yourself are used as well.
set -uo pipefail
PLAYLIST="${1:-${HOLD_MUSIC_PLAYLIST:-}}"
[ -n "$PLAYLIST" ] || { echo "usage: $0 <playlist url> [title regex]" >&2; exit 64; }
DIR="${OMP_BOT_STATE_DIR:-$HOME/.local/share/omp-discord-bot}/hold-music"
READY="$DIR/ready"
mkdir -p "$READY"
# Titles to keep (extended regex; default: every entry).
PICK="${2:-${HOLD_MUSIC_PICK:-.}}"
yt-dlp -q --no-warnings --flat-playlist --print "%(id)s|%(duration)s|%(title)s" "$PLAYLIST" > "$DIR/list.txt"
grep -E "$PICK" "$DIR/list.txt" | while IFS='|' read -r id dur title; do
  out="$READY/$id.ogg"
  [ -s "$out" ] && continue
  start=$(( dur > 1800 ? 600 : 60 ))
  url=$(yt-dlp -q --no-warnings -f bestaudio -g "https://youtu.be/$id" 2>/dev/null | head -1)
  [ -n "$url" ] || { echo "skip $id (no url)"; continue; }
  if ffmpeg -loglevel error -y -ss "$start" -t 600 -i "$url" -vn -af "volume=0.3" -c:a libopus -ar 48000 -ac 2 -b:a 64k -frame_duration 20 "$DIR/$id.part.ogg" </dev/null; then
    mv "$DIR/$id.part.ogg" "$out" && echo "ok $id $title"
  else
    rm -f "$DIR/$id.part.ogg"; echo "fail $id"
  fi
done
ls -la "$READY"
