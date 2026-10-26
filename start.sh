#!/usr/bin/env bash
# Starts Prompt Maker (and LM Studio's local server if needed), then opens it in the browser.
#   ./start.sh              start it, or just open it if it's already running. On Linux the first start also
#                           sets it up: app-menu and desktop launchers, a background service that starts it at login (and
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

# Opens the page as its own app window (a Chromium-family browser does app windows: Brave, Chromium, Chrome, Edge),
# with its own browser profile in the data folder, so it behaves like a desktop app. Without one, the page opens in
# whatever browser is the default. PM_BROWSER=/path forces a browser (or "default").
DATA="${PROMPT_MAKER_DATA:-${XDG_DATA_HOME:-$HOME/.local/share}/prompt-maker}"
open_app() {
  local bin="${PM_BROWSER:-}" profile="$DATA/browser"
  if [ -z "$bin" ]; then
    for c in brave-browser brave chromium chromium-browser google-chrome google-chrome-stable microsoft-edge; do
      command -v "$c" >/dev/null 2>&1 && { bin="$(command -v "$c")"; break; }
    done
  fi
  if [ -n "$bin" ] && [ "$bin" != default ]; then
    mkdir -p "$profile"
    # Chrome's custom Linux app frame squeezes the whole title bar, including minimize/maximize/close. This profile
    # belongs only to Prompt Maker, so ask Chrome to use the desktop's normal-sized title bar without changing the
    # person's regular browser. If this window is already open, the preference safely takes effect next time.
    "$NODE" lib/browser-profile.js "$profile" >/dev/null 2>&1 || true
    # On Wayland the browser ignores --class and names an app window "<browser>-<address>__-Default", so the dock
    # couldn't tie it to the app-menu entry and showed a gear. The window gets that name on X11 too (--class) and
    # the entry's StartupWMClass follows the browser in use, so the dock shows the green star on both. (1.68.3 opened
    # the window through XWayland for the icon instead; on NVIDIA that lost the GPU, and videos played choppy.)
    local wmclass; wmclass="$(wm_class "$bin")"
    name_entry "$wmclass"
    "$bin" --app="$URL" --user-data-dir="$profile" --no-first-run --no-default-browser-check --class="$wmclass" \
      --disable-component-update --disable-sync >/dev/null 2>&1 &
  else
    xdg-open "$URL" >/dev/null 2>&1 || true
  fi
  return 0
}
# The name a Chromium-family browser gives the app window on Wayland: its own short name, the page's address without
# the port, "__", and the profile ("brave-127.0.0.1__-Default"; checked on Brave 153 and Chrome).
wm_class() {
  local prefix
  case "$(basename "$1")" in
    brave*) prefix=brave ;; google-chrome*) prefix=chrome ;; chromium*) prefix=chromium ;; microsoft-edge*) prefix=msedge ;;
    *) echo prompt-maker; return 0 ;;
  esac
  echo "$prefix-$(sed -E 's#^[a-z]+://##; s#[:/].*##' <<<"$URL")__-Default"
}
# Points every launcher at that name, so the dock shows this window with Prompt Maker's icon whether it was opened
# from the app menu or from the desktop shortcut.
name_entry() {
  local entry desktop_dir="${XDG_DESKTOP_DIR:-}"
  if [ -z "$desktop_dir" ] && [ -f "$HOME/.config/user-dirs.dirs" ]; then
    desktop_dir="$(sed -n 's/^XDG_DESKTOP_DIR="\(.*\)"$/\1/p' "$HOME/.config/user-dirs.dirs")"
    desktop_dir="${desktop_dir/\$HOME/$HOME}"
  fi
  local desktop="${desktop_dir:-$HOME/Desktop}/Prompt Maker.desktop"
  for entry in "${XDG_DATA_HOME:-$HOME/.local/share}/applications/prompt-maker.desktop" "$desktop"; do
    [ -f "$entry" ] && grep -q '^StartupWMClass=' "$entry" && ! grep -qx "StartupWMClass=$1" "$entry" \
      && sed -i "s/^StartupWMClass=.*/StartupWMClass=$1/" "$entry" 2>/dev/null
  done
  return 0
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
