#!/usr/bin/env bash
# Starts Prompt Maker (and LM Studio's local server if needed), then opens it in the browser.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"

PORT="${PORT:-5317}"
URL="http://127.0.0.1:$PORT"
NODE="$(command -v node || echo "$HOME/.local/bin/node")"
LMS="$(command -v lms || echo "$HOME/.lmstudio/bin/lms")"

# Already running? Just bring it up in the browser.
if curl -fs -o /dev/null "$URL/api/settings"; then
  echo "Prompt Maker is already running at $URL"
  xdg-open "$URL" >/dev/null 2>&1 || true
  exit 0
fi

if [ -x "$LMS" ] && "$LMS" server status 2>&1 | grep -qi "not running"; then
  echo "Starting LM Studio server…"
  "$LMS" server start
fi

(sleep 1 && xdg-open "$URL" >/dev/null 2>&1 || true) &
exec "$NODE" server.js
