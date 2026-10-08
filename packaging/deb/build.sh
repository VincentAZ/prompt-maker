#!/usr/bin/env bash
# Builds the Ubuntu / Debian package: dist/prompt-maker_<version>_amd64.deb
#   packaging/deb/build.sh              fetches Node (the newest 22.x, kept in packaging/deb/cache) and builds
#   NODE_VERSION=v22.23.3 packaging/deb/build.sh    a pinned Node
# What the package holds:
#   /opt/prompt-maker/app     the app, as in this repo (nothing from any data folder)
#   /opt/prompt-maker/node    Node.js, its own copy: nothing to install first, no version to get wrong
#   /usr/bin/prompt-maker     starts it (the app's own start.sh, with that Node); --install / --uninstall as there
#   an app-menu entry and icon, and the promptmaker:// link for the page's Start button
# Per-user setup (the background service, start with the computer) is done by the app on its first start, as
# always: a package can't do it, it runs as root. LM Studio and ComfyUI are separate installs (see the README).
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")/../.."
ROOT="$PWD"
VERSION="$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' package.json | head -1)"
ARCH=amd64
NODE_ARCH=linux-x64
CACHE="$ROOT/packaging/deb/cache"
OUT="$ROOT/dist"
mkdir -p "$CACHE" "$OUT"

# Node: the newest 22.x unless pinned.
NODE_VERSION="${NODE_VERSION:-$(curl -fsSL https://nodejs.org/dist/index.json | sed -n 's/.*"version":"\(v22\.[0-9.]*\)".*/\1/p' | head -1)}"
[ -n "$NODE_VERSION" ] || { echo "Couldn't find a Node 22 release to bundle."; exit 1; }
TARBALL="$CACHE/node-$NODE_VERSION-$NODE_ARCH.tar.xz"
if [ ! -f "$TARBALL" ]; then
  echo "Fetching Node $NODE_VERSION…"
  curl -fsSL -o "$TARBALL" "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-$NODE_ARCH.tar.xz"
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" | grep " node-$NODE_VERSION-$NODE_ARCH.tar.xz\$" > "$TARBALL.sha256"
  (cd "$CACHE" && sha256sum -c --quiet "$TARBALL.sha256") || { echo "Node download didn't match its checksum."; rm -f "$TARBALL"; exit 1; }
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
PKG="$STAGE/pkg"
APP="$PKG/opt/prompt-maker/app"
mkdir -p "$APP" "$PKG/opt/prompt-maker/node" "$PKG/usr/bin" "$PKG/usr/share/applications" "$PKG/usr/share/icons/hicolor/scalable/apps" "$PKG/DEBIAN"

# The app: what the repo ships, nothing else (no data folder, no tests, no screenshots).
for f in server.js package.json start.sh LICENSE README.md lib public playbooks chains workflows; do cp -r "$ROOT/$f" "$APP/"; done
find "$APP" -name '*.tmp' -delete
chmod 755 "$APP/start.sh"

# Node, without its docs and npm (the app has no dependencies).
tar -xJf "$TARBALL" -C "$PKG/opt/prompt-maker/node" --strip-components=1
rm -rf "$PKG/opt/prompt-maker/node/lib/node_modules" "$PKG/opt/prompt-maker/node/share" "$PKG/opt/prompt-maker/node/include" "$PKG/opt/prompt-maker/node/bin/npm" "$PKG/opt/prompt-maker/node/bin/npx" "$PKG/opt/prompt-maker/node/bin/corepack" "$PKG/opt/prompt-maker/node/CHANGELOG.md" "$PKG/opt/prompt-maker/node/README.md"

cat > "$PKG/usr/bin/prompt-maker" <<'SH'
#!/bin/sh
# Prompt Maker: starts it (or opens it if it's running), with the Node.js that came with it. --install / --uninstall
# set up or remove the app-menu entry and the background service for your user, as the app's start.sh does.
exec /opt/prompt-maker/app/start.sh "$@"
SH
chmod 755 "$PKG/usr/bin/prompt-maker"

cat > "$PKG/usr/share/applications/prompt-maker.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Prompt Maker
Comment=Say what you want to see and get pictures and videos made on your own computer
Exec=prompt-maker %u
Icon=prompt-maker
Terminal=false
Categories=Graphics;AudioVideo;
MimeType=x-scheme-handler/promptmaker;
Keywords=AI;image;video;prompt;ComfyUI;
DESKTOP
cp "$ROOT/public/icon.svg" "$PKG/usr/share/icons/hicolor/scalable/apps/prompt-maker.svg"

SIZE_KB="$(du -sk "$PKG" | cut -f1)"
cat > "$PKG/DEBIAN/control" <<CONTROL
Package: prompt-maker
Version: $VERSION
Section: graphics
Priority: optional
Architecture: $ARCH
Depends: libc6 (>= 2.28), libstdc++6, curl, xdg-utils
Recommends: ffmpeg, git, python3-venv, python3-pip
Installed-Size: $SIZE_KB
Maintainer: Serpico Enterprises LLC <noreply@github.com>
Homepage: https://github.com/VincentAZ/prompt-maker
Description: Pictures and videos made on your own computer, from plain words
 Say what you want to see and get pictures and videos made on your own
 computer. Nothing leaves your machine. Comes with its own Node.js; needs
 LM Studio (the Brain) and, to render, ComfyUI (both free). Settings sets up
 ComfyUI in one click. Open it from the app menu: the first start sets up the rest.
CONTROL
cat > "$PKG/DEBIAN/postinst" <<'POST'
#!/bin/sh
set -e
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q /usr/share/applications || true
command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor 2>/dev/null || true
echo "Prompt Maker is installed. Open it from your app menu (or run: prompt-maker). The first start sets up the rest."
POST
cat > "$PKG/DEBIAN/postrm" <<'POST'
#!/bin/sh
set -e
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q /usr/share/applications || true
POST
chmod 755 "$PKG/DEBIAN/postinst" "$PKG/DEBIAN/postrm"

DEB="$OUT/prompt-maker_${VERSION}_$ARCH.deb"
fakeroot dpkg-deb --build --root-owner-group -Zxz "$PKG" "$DEB" >/dev/null
echo "Built $DEB ($(du -h "$DEB" | cut -f1), Node $NODE_VERSION)"
