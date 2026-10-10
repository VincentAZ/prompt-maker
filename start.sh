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
# The Node.js that came with the package (a .deb puts it beside the app), else the one on this computer.
BUNDLED="$(dirname "$PWD")/node/bin/node"
NODE="$( [ -x "$BUNDLED" ] && echo "$BUNDLED" || command -v node || echo "$HOME/.local/bin/node")"
LMS="$(command -v lms || echo "$HOME/.lmstudio/bin/lms")"
SETUP=(env PORT="$PORT" LMS_BIN="$LMS" "$NODE" lib/autostart.js)

running() { curl -fs -o /dev/null "$URL/api/settings"; }

# Opens the page as its own window, with its own browser profile, so Prompt Maker leaves nothing in your everyday
# browser's history or session. The profile sits in the data folder; at the Safer and "Nothing stays" privacy levels,
# in memory (its own files keep old copies of what the page showed, which a delete can't reach). A Chromium-family browser does app windows (Brave, Chromium, Chrome, Edge); without
# one, the page opens in whatever browser is the default. PM_BROWSER=/path forces a browser (or "default").
DATA="${PROMPT_MAKER_DATA:-${XDG_DATA_HOME:-$HOME/.local/share}/prompt-maker}"
open_app() {
  local bin="${PM_BROWSER:-}" profile="$DATA/browser"
  if grep -qsE '"(dataRam|comfyRam)": true' "$DATA/settings.json"; then
    profile="${PM_RAM_DIR:-/dev/shm}/prompt-maker-session/browser"
    # A profile left on disk by a lower level goes (shredded), unless a window still runs from it.
    if [ -d "$DATA/browser" ] && ! pgrep -f -- "--user-data-dir=$DATA/browser" >/dev/null 2>&1; then
      if command -v shred >/dev/null 2>&1; then find "$DATA/browser" -type f -exec shred -u -n 3 {} + 2>/dev/null; fi
      rm -rf "$DATA/browser"
    fi
  fi
  if [ -z "$bin" ]; then
    for c in brave-browser brave chromium chromium-browser google-chrome google-chrome-stable microsoft-edge; do
      command -v "$c" >/dev/null 2>&1 && { bin="$(command -v "$c")"; break; }
    done
  fi
  if [ -n "$bin" ] && [ "$bin" != default ]; then
    mkdir -p "$profile"
    "$bin" --app="$URL" --user-data-dir="$profile" --no-first-run --no-default-browser-check --class=prompt-maker >/dev/null 2>&1 &
  else
    xdg-open "$URL" >/dev/null 2>&1 || true
  fi
}
wait_up() { for _ in $(seq 1 60); do running && return 0; service_failing && return 1; sleep 1; done; return 1; }
# The service stopped with an error (and is waiting to retry, or gave up): don't wait the full minute for it.
service_failing() { systemctl --user show -p SubState --value prompt-maker.service 2>/dev/null | grep -qE '^(auto-restart|failed)$'; }
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
# Set up for a copy that's gone (the package removed, the folder moved), or by an older version: point it here.
elif [ "$(field missing <<<"$STATUS")" = true ] || [ "$(field old <<<"$STATUS")" = true ]; then
  STATUS="$("${SETUP[@]}" repair)"
fi

# Set up as a service but stopped? Start the service rather than a second copy.
if ! running && [ "$(field service <<<"$STATUS")" = true ]; then
  systemctl --user start prompt-maker.service
  # It won't come up: stop its retrying and start Prompt Maker right here instead (below).
  wait_up || systemctl --user stop prompt-maker.service
fi

if running; then
  echo "Prompt Maker is running at $URL"
  $FROM_LINK || open_app
  exit 0
fi

if [ -x "$LMS" ] && "$LMS" server status 2>&1 | grep -qi "not running"; then
  echo "Starting LM Studio server…"
  "$LMS" server start
fi

$FROM_LINK || (sleep 1 && open_app) &
exec "$NODE" server.js
