#!/usr/bin/env bash
# Starts Prompt Maker (and LM Studio's local server if needed), then opens it in the browser.
#   ./start.sh              start it, or just open it if it's already running. On Linux the first start also
#                           sets it up: an app-menu entry, a background service that starts it at login (and
#                           LM Studio's server), and the link the page's Start button uses. Undo: --uninstall
#   ./start.sh --install    set that up again (after --uninstall)
#   ./start.sh --uninstall  remove it; start Prompt Maker by hand from then on
# Also what the app-menu entry and the promptmaker://start link run.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"

PORT="${PORT:-5317}"
URL="http://127.0.0.1:$PORT"
NODE="$(command -v node || echo "$HOME/.local/bin/node")"
LMS="$(command -v lms || echo "$HOME/.lmstudio/bin/lms")"
SETUP=(env PORT="$PORT" LMS_BIN="$LMS" "$NODE" lib/autostart.js)

running() { curl -fs -o /dev/null "$URL/api/settings"; }
wait_up() { for _ in $(seq 1 60); do running && return 0; sleep 1; done; return 1; }
field() { sed -n "s/.*\"$1\":\([a-z]*\).*/\1/p"; } # reads one true/false from the status JSON

case "${1:-}" in
  --install)
    "${SETUP[@]}" install "$(running || echo --now)" >/dev/null
    wait_up && echo "Prompt Maker is set up: it's in your app menu, starts with your computer, and runs at $URL" \
      || echo "Set up, but Prompt Maker isn't answering yet. See: journalctl --user -u prompt-maker"
    exit 0 ;;
  --uninstall)
    "${SETUP[@]}" uninstall >/dev/null
    echo "Removed. Start Prompt Maker with ./start.sh when you need it (./start.sh --install sets it up again)."
    exit 0 ;;
esac

# Opened from the page's Start button: no need for another browser tab, the page reconnects on its own.
FROM_LINK=false
[[ "${1:-}" == promptmaker://* ]] && FROM_LINK=true

# First start on Linux: set it up once (unless you removed the setup before).
STATUS="$("${SETUP[@]}" status 2>/dev/null || echo '{}')"
if [ "$(field supported <<<"$STATUS")" = true ] && [ "$(field declined <<<"$STATUS")" != true ] \
  && { [ "$(field service <<<"$STATUS")" != true ] || [ "$(field launcher <<<"$STATUS")" != true ]; }; then
  echo "Setting Prompt Maker up: app menu, start with your computer… (undo: ./start.sh --uninstall)"
  STATUS="$("${SETUP[@]}" install "$(running || echo --now)")"
fi

# Set up as a service but stopped? Start the service rather than a second copy.
if ! running && [ "$(field service <<<"$STATUS")" = true ]; then
  systemctl --user start prompt-maker.service
  wait_up || true
fi

if running; then
  echo "Prompt Maker is running at $URL"
  $FROM_LINK || xdg-open "$URL" >/dev/null 2>&1 || true
  exit 0
fi

if [ -x "$LMS" ] && "$LMS" server status 2>&1 | grep -qi "not running"; then
  echo "Starting LM Studio server…"
  "$LMS" server start
fi

$FROM_LINK || (sleep 1 && xdg-open "$URL" >/dev/null 2>&1 || true) &
exec "$NODE" server.js
