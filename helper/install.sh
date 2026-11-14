#!/usr/bin/env bash
# Registers the Hub helper with Firefox so the dashboard can start Claude Code.
# Safe to run again. To undo: delete the hub_helper.json files it prints.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
HOST="$HERE/hub_helper.py"
chmod +x "$HOST"

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

echo "Done. Restart Firefox, then use Options → Check helper."
