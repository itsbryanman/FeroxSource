#!/usr/bin/env bash
# Records the dashboard beats on an X display (default :1, the VNC desktop).
# No audio. Record the voiceover separately and lay it over.
#
#   scripts/record-demo.sh               local git backend
#   CLOUD=1 scripts/record-demo.sh       Artifacts backend (.env.cloud)
#   CLOUD=1 AGENT=1 scripts/record-demo.sh   + real Claude Code replay beat
#   PACE=1.4 ...                         slower pauses
set -euo pipefail
cd "$(dirname "$0")/.."
export DISPLAY="${DISPLAY_NUM:-:1}"
SIZE=$(xdpyinfo -display "$DISPLAY" 2>/dev/null | awk '/dimensions/{print $2}' || echo 1920x1080)
OUT="video/raw/ferox-$(date +%Y%m%d-%H%M%S).mp4"
mkdir -p video/raw
DATA=$(mktemp -d)

ENVFILE=()
[[ "${CLOUD:-0}" == 1 ]] && ENVFILE=(--env-file=.env.cloud)
AGENT_ENV=()
[[ "${AGENT:-0}" == 1 ]] && AGENT_ENV=(FEROX_AGENT=claude)

env "${AGENT_ENV[@]}" FEROX_DATA="$DATA" PORT=8788 node "${ENVFILE[@]}" src/server.mjs &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT
sleep 2

FRAMES=$(mktemp -d)
WITH_AGENT="${AGENT:-0}" node scripts/demo-driver.mjs &
DRIVER=$!
FRAME=0
while kill -0 "$DRIVER" 2>/dev/null; do
  printf -v FILE '%s/frame-%06d.png' "$FRAMES" "$FRAME"
  scrot "$FILE"
  FRAME=$((FRAME + 1))
  sleep 0.2
done
wait "$DRIVER"

# TightVNC can return black frames through X11 SHM capture. scrot reads the
# real framebuffer, so record a steady image sequence and encode it afterward.
ffmpeg -loglevel error -y -framerate 4 -i "$FRAMES/frame-%06d.png" \
  -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p "$OUT"
rm -r "$FRAMES"
echo "saved $OUT"
