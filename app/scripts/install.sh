#!/usr/bin/env bash
# Build Jivvy Life (Electron) from source and install it for the current user (no root).
# Safe to run while the app is open: the new copy is swapped in atomically; restart the app to use it.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

LIB_DIR="$HOME/.local/lib/jivvy-life"
BIN_DIR="$HOME/.local/bin"
ICON_ROOT="$HOME/.local/share/icons/hicolor"
DESKTOP_DIR="$HOME/.local/share/applications"
PKG="$APP_DIR/out/jivvy-life-linux-x64"

if [ ! -d node_modules ]; then
  npm ci
fi
npm run electron:package
[ -x "$PKG/jivvy-life" ] || { echo "Package not found: $PKG" >&2; exit 1; }

# Atomic swap: copy next to the target, rename old aside, rename new into place, delete old.
mkdir -p "$(dirname "$LIB_DIR")"
rm -rf "$LIB_DIR.new" "$LIB_DIR.old"
cp -a "$PKG" "$LIB_DIR.new"
[ -e "$LIB_DIR" ] && mv "$LIB_DIR" "$LIB_DIR.old"
mv "$LIB_DIR.new" "$LIB_DIR"
rm -rf "$LIB_DIR.old"

# Wrapper (replaces anything already there, including the old Tauri binary).
mkdir -p "$BIN_DIR"
TMP="$(mktemp "$BIN_DIR/.jivvy-life.XXXXXX")"
trap 'rm -f "$TMP"' EXIT
printf '#!/bin/sh\nexec "%s/jivvy-life" "$@"\n' "$LIB_DIR" > "$TMP"
chmod 755 "$TMP"
mv -f "$TMP" "$BIN_DIR/jivvy-life"
trap - EXIT

install_icon() { # <src file> <size dir>
  mkdir -p "$ICON_ROOT/$2/apps"
  cp "$APP_DIR/assets/icons/$1" "$ICON_ROOT/$2/apps/jivvy-life.png"
}
install_icon 32x32.png 32x32
install_icon 128x128.png 128x128
install_icon 256x256.png 256x256

# Registered as a possible http/https handler only; this does NOT make it the default browser.
mkdir -p "$DESKTOP_DIR"
cat > "$DESKTOP_DIR/jivvy-life.desktop" <<EOD
[Desktop Entry]
Type=Application
Name=Jivvy Life
Comment=Jivvy Life workspace
Exec=$HOME/.local/bin/jivvy-life %U
Icon=jivvy-life
StartupWMClass=jivvy-life
Categories=Network;WebBrowser;Office;
Terminal=false
MimeType=x-scheme-handler/http;x-scheme-handler/https;
EOD

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$DESKTOP_DIR" || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -f -t "$ICON_ROOT" >/dev/null 2>&1 || true
fi

echo "Installed Jivvy Life:"
echo "  app:      $LIB_DIR"
echo "  command:  $BIN_DIR/jivvy-life"
echo "  launcher: $DESKTOP_DIR/jivvy-life.desktop"
echo "  icons:    $ICON_ROOT/{32x32,128x128,256x256}/apps/jivvy-life.png"
echo "  data:     ~/.config/jivvy-life (untouched)"
echo "If Jivvy Life is open, restart it to run the new version."

# Video playback (YouTube etc.) needs system GStreamer codecs; warn but never fail the install.
if command -v gst-inspect-1.0 >/dev/null 2>&1; then
  if ! gst-inspect-1.0 fakevideosink >/dev/null 2>&1 || ! gst-inspect-1.0 avdec_h264 >/dev/null 2>&1; then
    echo "WARNING: Video playback (YouTube etc.) needs: sudo apt install gstreamer1.0-plugins-bad gstreamer1.0-libav" >&2
  fi
fi
