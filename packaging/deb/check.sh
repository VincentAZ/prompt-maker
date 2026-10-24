#!/usr/bin/env bash
# Checks a built package without installing it: unpacks it, starts the app from there with the Node.js it bundles
# (in a throwaway home, so nothing of yours is set up or touched), and asks it for its version.
#   packaging/deb/check.sh [dist/prompt-maker_<version>_amd64.deb]
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")/../.."
DEB="${1:-$(ls -t dist/prompt-maker_*_amd64.deb | head -1)}"
WORK="$(mktemp -d)"
trap 'kill "${PID:-}" 2>/dev/null || true; rm -rf "$WORK"' EXIT
dpkg-deb -x "$DEB" "$WORK/root"
mkdir -p "$WORK/home/.config/prompt-maker" "$WORK/data"
touch "$WORK/home/.config/prompt-maker/no-auto-setup" # a throwaway home: no app-menu entry or service for it
PORT=5398
curl -fs -o /dev/null "http://127.0.0.1:$PORT/api/settings" && { echo "Something already answers on port $PORT; stop it first."; exit 1; }
(cd "$WORK/root/opt/prompt-maker/app" && HOME="$WORK/home" XDG_CONFIG_HOME="$WORK/home/.config" XDG_DATA_HOME="$WORK/home/.local/share" \
  PORT=$PORT PROMPT_MAKER_DATA="$WORK/data" SYSTEMCTL_BIN=/bin/true PATH=/usr/bin:/bin ./start.sh promptmaker://start > "$WORK/log" 2>&1) &
PID=$!
for _ in $(seq 1 30); do curl -fs -o /dev/null "http://127.0.0.1:$PORT/api/settings" && break; sleep 1; done
VERSION="$(curl -fs "http://127.0.0.1:$PORT/api/settings" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"
# Node renames its process, so the server is found by where it runs from, and the Node it runs on by its program.
SERVER_PID=""
for pid in $(pgrep -x node || true); do [ "$(readlink "/proc/$pid/cwd" 2>/dev/null)" = "$WORK/root/opt/prompt-maker/app" ] && SERVER_PID="$pid"; done
NODE_USED="$( [ -n "$SERVER_PID" ] && readlink "/proc/$SERVER_PID/exe" || echo "no server process found")"
kill "$PID" 2>/dev/null; [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
[ -n "$VERSION" ] || { echo "The app didn't answer. Its output:"; cat "$WORK/log"; exit 1; }
case "$NODE_USED" in "$WORK/root/opt/prompt-maker/node/bin/node") ;; *) echo "It ran with $NODE_USED, not the bundled Node."; exit 1;; esac
[ -z "$(ls -A "$WORK/home/.local/share/applications" 2>/dev/null)" ] || { echo "It set up an app-menu entry although asked not to."; exit 1; }
echo "OK: $DEB starts Prompt Maker $VERSION with its own Node ($("$WORK/root/opt/prompt-maker/node/bin/node" --version))."
