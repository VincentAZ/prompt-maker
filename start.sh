#!/usr/bin/env bash
# Starts Prompt Maker (and LM Studio's local server if needed), then opens it in the browser.
#   ./start.sh              start it (or just open it, if it's already running)
#   ./start.sh --install    Linux: start it with your computer from now on, as a background service that
#                           also starts LM Studio's server and restarts Prompt Maker if it ever stops
#   ./start.sh --uninstall  Linux: stop starting it with your computer
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"

PORT="${PORT:-5317}"
URL="http://127.0.0.1:$PORT"
NODE="$(command -v node || echo "$HOME/.local/bin/node")"
LMS="$(command -v lms || echo "$HOME/.lmstudio/bin/lms")"
SERVICE="prompt-maker.service"
UNIT="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$SERVICE"

running() { curl -fs -o /dev/null "$URL/api/settings"; }

if [ "${1:-}" = "--install" ] || [ "${1:-}" = "--uninstall" ]; then
  if [ "$(uname)" != "Linux" ] || ! command -v systemctl >/dev/null; then
    echo "Starting with your computer is only set up for Linux (systemd) so far."
    exit 1
  fi
  if [ "$1" = "--uninstall" ]; then
    systemctl --user disable --now "$SERVICE" 2>/dev/null || true
    rm -f "$UNIT"
    systemctl --user daemon-reload
    echo "Prompt Maker no longer starts with your computer. Start it with ./start.sh when you need it."
    exit 0
  fi
  if running && ! systemctl --user is-active --quiet "$SERVICE"; then
    echo "Prompt Maker is already running outside the service. Stop it first (Ctrl+C in its terminal), then run ./start.sh --install again."
    exit 1
  fi
  mkdir -p "$(dirname "$UNIT")"
  cat > "$UNIT" <<EOF
[Unit]
Description=Prompt Maker (offline prompt writer)
After=network.target

[Service]
WorkingDirectory=$PWD
Environment=PORT=$PORT
# Start LM Studio's server too, if it's installed and off. Never blocks Prompt Maker from starting.
ExecStartPre=-/bin/sh -c '[ -x "$LMS" ] && "$LMS" server status 2>&1 | grep -qi "not running" && "$LMS" server start; true'
ExecStart=$NODE server.js
Restart=on-failure
RestartSec=3
TimeoutStartSec=120

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now "$SERVICE"
  for _ in $(seq 1 60); do running && break; sleep 1; done
  if running; then
    echo "Prompt Maker now starts with your computer and runs at $URL"
    echo "Logs: journalctl --user -u prompt-maker -f    Undo: ./start.sh --uninstall"
  else
    echo "The service is installed but Prompt Maker isn't answering yet. See: journalctl --user -u prompt-maker"
    exit 1
  fi
  exit 0
fi

# Installed as a service but stopped? Start the service rather than a second copy.
if ! running && [ -f "$UNIT" ]; then
  systemctl --user start "$SERVICE"
  for _ in $(seq 1 60); do running && break; sleep 1; done
fi

# Already running? Just bring it up in the browser.
if running; then
  echo "Prompt Maker is running at $URL"
  xdg-open "$URL" >/dev/null 2>&1 || true
  exit 0
fi

if [ -x "$LMS" ] && "$LMS" server status 2>&1 | grep -qi "not running"; then
  echo "Starting LM Studio server…"
  "$LMS" server start
fi

(sleep 1 && xdg-open "$URL" >/dev/null 2>&1 || true) &
exec "$NODE" server.js
