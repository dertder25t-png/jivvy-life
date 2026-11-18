#!/usr/bin/env bash
# Build Jivvy Life and install it for the current user (app menu + taskbar-pinnable launcher).
# No sudo. Re-run after pulling updates. Run from app/:  ./branding/install-linux.sh
set -euo pipefail
cd "$(dirname "$0")/.."
npx tauri build --no-bundle
mkdir -p ~/.local/opt/jivvy-life ~/.local/share/applications
install -m755 src-tauri/target/release/life-app ~/.local/opt/jivvy-life/life-app
for s in 32 64 128 256 512; do
  d=~/.local/share/icons/hicolor/${s}x${s}/apps; mkdir -p "$d"
  python3 -c "from PIL import Image; Image.open('branding/logo-1024.png').resize(($s,$s), Image.LANCZOS).save('$d/life-app.png')"
done
# StartupWMClass must match the window's app id (the binary name) so the pinned icon and window group.
cat > ~/.local/share/applications/life-app.desktop <<DESKTOP
[Desktop Entry]
Type=Application
Name=Jivvy Life
GenericName=Workspace
Comment=Dashboard, tabs and notes in one window
Exec=$HOME/.local/opt/jivvy-life/life-app
Icon=life-app
Terminal=false
Categories=Office;
StartupWMClass=life-app
StartupNotify=true
DESKTOP
update-desktop-database ~/.local/share/applications 2>/dev/null || true
gtk-update-icon-cache -q ~/.local/share/icons/hicolor 2>/dev/null || true
kbuildsycoca6 >/dev/null 2>&1 || kbuildsycoca5 >/dev/null 2>&1 || true
echo "Installed. Find 'Jivvy Life' in your app menu."
