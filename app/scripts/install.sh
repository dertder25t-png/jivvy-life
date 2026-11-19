#!/usr/bin/env bash
# Build Jivvy Life from source and install it for the current user (no AppImage, no root).
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

BIN_DIR="$HOME/.local/bin"
ICON_ROOT="$HOME/.local/share/icons/hicolor"
DESKTOP_DIR="$HOME/.local/share/applications"

if [ ! -d node_modules ]; then
  npm ci
fi

npx tauri build --no-bundle

BUILT="$APP_DIR/src-tauri/target/release/jivvy-life"
[ -x "$BUILT" ] || { echo "Build output not found: $BUILT" >&2; exit 1; }

mkdir -p "$BIN_DIR"
TMP="$(mktemp "$BIN_DIR/.jivvy-life.XXXXXX")"
trap 'rm -f "$TMP"' EXIT
cp "$BUILT" "$TMP"
chmod 755 "$TMP"
mv -f "$TMP" "$BIN_DIR/jivvy-life"
trap - EXIT

install_icon() { # <src file> <size dir>
  mkdir -p "$ICON_ROOT/$2/apps"
  cp "$APP_DIR/src-tauri/icons/$1" "$ICON_ROOT/$2/apps/jivvy-life.png"
}
install_icon 32x32.png 32x32
install_icon 128x128.png 128x128
install_icon 128x128@2x.png 256x256

mkdir -p "$DESKTOP_DIR"
cat > "$DESKTOP_DIR/jivvy-life.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Jivvy Life
Comment=Jivvy Life workspace
Exec=$HOME/.local/bin/jivvy-life
Icon=jivvy-life
StartupWMClass=jivvy-life
Categories=Office;Network;WebBrowser;
Terminal=false
EOF

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$DESKTOP_DIR" || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -f -t "$ICON_ROOT" >/dev/null 2>&1 || true
fi

echo "Installed Jivvy Life:"
echo "  binary:   $BIN_DIR/jivvy-life"
echo "  launcher: $DESKTOP_DIR/jivvy-life.desktop"
echo "  icons:    $ICON_ROOT/{32x32,128x128,256x256}/apps/jivvy-life.png"
