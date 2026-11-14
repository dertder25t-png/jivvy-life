#!/usr/bin/env bash
# Registers the Hub helper with Firefox so the dashboard can start Claude Code, and sets up
# predictive moves: a laya token, the nightly history miner, and the Meta+Shift+. shortcut.
#   helper/install.sh [--seed intent.json]   (--seed also writes seed_local.json from that file)
# Safe to run again. To undo: delete the hub_helper.json files it prints;
#   systemctl --user disable --now hub-miner.timer; rm ~/.local/share/applications/lifeboard-next.desktop
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
HOST="$HERE/hub_helper.py"
NEXT="$HERE/lifeboard-next"
SEED=""
while [ $# -gt 0 ]; do
  case "$1" in
    --seed) SEED="${2:?--seed needs a file}"; shift 2 ;;
    *) echo "Unknown option: $1 (use --seed FILE)" >&2; exit 2 ;;
  esac
done
chmod +x "$HOST" "$NEXT" "$HERE/pattern_miner.py"
PY=/usr/bin/python3
[ -x "$PY" ] || PY="$(command -v python3)"

MANIFEST=$(cat <<JSON
{
  "name": "hub_helper",
  "description": "Hub Dashboard local helper",
  "path": "$HOST",
  "type": "stdio",
  "allowed_extensions": ["hub-dashboard@local"]
}
JSON
)

# Regular Firefox, plus the snap's own folder (snap Firefox reaches the helper through the desktop portal).
for DIR in "$HOME/.mozilla/native-messaging-hosts" "$HOME/snap/firefox/common/.mozilla/native-messaging-hosts"; do
  if [ "$DIR" = "$HOME/snap/firefox/common/.mozilla/native-messaging-hosts" ] && [ ! -d "$HOME/snap/firefox" ]; then
    continue
  fi
  mkdir -p "$DIR"
  printf '%s\n' "$MANIFEST" > "$DIR/hub_helper.json"
  echo "Wrote $DIR/hub_helper.json"
done

CFG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/hub-dashboard"
if [ ! -f "$CFG_DIR/helper.json" ]; then
  mkdir -p "$CFG_DIR"
  cat > "$CFG_DIR/helper.json" <<JSON
{
  "allowed_roots": ["$HOME"],
  "terminal": ["konsole", "--workdir", "{cwd}", "-e"],
  "claude": null
}
JSON
  echo "Wrote $CFG_DIR/helper.json (edit allowed_roots to limit where Claude Code may start)"
fi

# Token that lets the miner ask laya (no browser Origin header) — random, readable only by you.
TOKEN="$CFG_DIR/laya-token"
if [ ! -f "$TOKEN" ]; then
  mkdir -p "$CFG_DIR"
  (umask 077; "$PY" -I -c 'import secrets; print(secrets.token_hex(32))' > "$TOKEN")
  echo "Wrote $TOKEN"
fi
chmod 600 "$TOKEN"

# Nightly pattern miner (reads a private copy of Firefox history; output stays in ~/.local/share).
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/hub-miner.service" <<UNIT
[Unit]
Description=Lifeboard pattern miner (Firefox history -> predictive moves)

[Service]
Type=oneshot
ExecStart=$PY -I "$HERE/pattern_miner.py"
Nice=10
IOSchedulingClass=idle
UNIT
cat > "$UNIT_DIR/hub-miner.timer" <<UNIT
[Unit]
Description=Run the Lifeboard pattern miner daily

[Timer]
OnCalendar=daily
Persistent=true
RandomizedDelaySec=15min

[Install]
WantedBy=timers.target
UNIT
if command -v systemctl >/dev/null; then
  systemctl --user daemon-reload
  systemctl --user enable --now hub-miner.timer
  systemctl --user start --no-block hub-miner.service  # first scan now, not at midnight
  echo "Installed hub-miner.timer (daily)"
fi

if [ -n "$SEED" ]; then
  "$PY" -I "$HERE/pattern_miner.py" --seed "$SEED" --print
fi

# Meta+Shift+. runs lifeboard-next. Plasma stores a shifted key as the character it types,
# without "Shift" (this setup already has "Meta+~" for Meta+Shift+`), so Shift+. is "Meta+>".
# NoDisplay keeps it out of the app menu; kglobalaccel still finds it by its file name.
APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
mkdir -p "$APPS"
cat > "$APPS/lifeboard-next.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Lifeboard next move
Comment=Open the move Lifeboard has ready
Exec="$NEXT"
NoDisplay=true
DESKTOP
command -v kbuildsycoca6 >/dev/null && kbuildsycoca6 >/dev/null 2>&1 || true
KEY='Meta+>'
SHORTCUTS="${XDG_CONFIG_HOME:-$HOME/.config}/kglobalshortcutsrc"
if command -v kwriteconfig6 >/dev/null; then
  CURRENT="$(kreadconfig6 --file kglobalshortcutsrc --group services --group lifeboard-next.desktop --key _launch 2>/dev/null || true)"
  if [ -n "$CURRENT" ]; then
    echo "Shortcut already set for lifeboard-next: $CURRENT (left as is)"
  elif [ -f "$SHORTCUTS" ] && grep -qF "=$KEY" "$SHORTCUTS"; then
    echo "Meta+Shift+. is already used by another shortcut; not changing it."
    echo "Pick a key in System Settings → Keyboard → Shortcuts → Add New → Command or Script: $NEXT"
  else
    kwriteconfig6 --file kglobalshortcutsrc --group services --group lifeboard-next.desktop --key _launch "$KEY"
    # kglobalaccel (inside KWin on Plasma 6) reads this file only at login and has no reload call,
    # so the new key works after the next login.
    echo "Bound Meta+Shift+. to lifeboard-next. Log out and back in to turn it on,"
    echo "or set it now in System Settings → Keyboard → Shortcuts → Add New → Command or Script: $NEXT"
  fi
else
  echo "To use the shortcut, add one in your desktop's keyboard settings that runs: $NEXT"
fi

echo "Done. Restart Firefox, then use Options → Check helper."
