#!/usr/bin/env bash
# Remove the files app:install created. User data in ~/.config/jivvy-life is kept.
set -euo pipefail
ICON_ROOT="$HOME/.local/share/icons/hicolor"
DESKTOP_DIR="$HOME/.local/share/applications"
rm -rf "$HOME/.local/lib/jivvy-life" "$HOME/.local/lib/jivvy-life.new" "$HOME/.local/lib/jivvy-life.old"
rm -f "$HOME/.local/bin/jivvy-life" "$DESKTOP_DIR/jivvy-life.desktop"
for s in 32x32 128x128 256x256; do rm -f "$ICON_ROOT/$s/apps/jivvy-life.png"; done
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$DESKTOP_DIR" || true
command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -f -t "$ICON_ROOT" >/dev/null 2>&1 || true
echo "Removed Jivvy Life (app, command, launcher, icons). Your data in ~/.config/jivvy-life was kept."
