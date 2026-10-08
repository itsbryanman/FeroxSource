#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="video/ferox-demo.mp4"
FRAMES=$(mktemp -d)
DATA=$(mktemp -d)
PORT=8897
FPS=8

set -a
source .env.cloud
set +a

FEROX_DATA="$DATA" PORT="$PORT" node src/server.mjs &
SERVER=$!
trap 'kill "$SERVER" 2>/dev/null || true' EXIT
sleep 2

FEROX_URL="http://127.0.0.1:$PORT" FEROX_FRAMES="$FRAMES" FPS="$FPS" PACE=1 node scripts/perfect-demo.mjs
ffmpeg -loglevel error -y -framerate "$FPS" -i "$FRAMES/frame-%06d.jpg" \
  -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -movflags +faststart "$OUT"

rm -r "$FRAMES" "$DATA"
echo "saved $OUT"
