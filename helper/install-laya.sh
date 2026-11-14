#!/usr/bin/env bash
# Installs the laya decision service: a Python environment with laya, laya's vega reader
# (~2 GB download, trained on tools/seed.jsonl in about 2 minutes), and a user service that keeps it running.
# Safe to run again. To undo: systemctl --user disable --now hub-laya; rm -rf ~/.local/share/hub-dashboard
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}/hub-dashboard"
VENV="$DATA/laya-venv"
PY="$VENV/bin/python"

# A leftover environment without pip (from a failed earlier run) is rebuilt.
if [ -x "$PY" ] && ! command -v uv >/dev/null && ! "$PY" -m pip --version >/dev/null 2>&1; then
  echo "Rebuilding an incomplete Python environment."
  rm -rf "$VENV"
fi

if [ ! -x "$PY" ]; then
  mkdir -p "$DATA"
  if command -v uv >/dev/null; then
    uv venv -q --python 3.12 "$VENV"
  elif python3 -m venv "$VENV" 2>/dev/null; then
    :
  else
    rm -rf "$VENV"
    echo "Python can't make environments yet. Run this once, then run this script again:"
    echo "  sudo apt install python3-venv python3-pip"
    exit 1
  fi
fi

pip_install() {
  if command -v uv >/dev/null; then uv pip install -q --python "$PY" "$@"; else "$PY" -m pip install -q "$@"; fi
}
echo "Installing PyTorch (CPU) and laya. This takes a few minutes the first time."
pip_install torch --index-url https://download.pytorch.org/whl/cpu
pip_install -U laya

echo "Downloading the model, training it on the dashboard's examples, and testing it:"
USE_TF=0 "$PY" "$HERE/laya_server.py" "weather tomorrow" "explain how wifi works"

UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/hub-laya.service" <<UNIT
[Unit]
Description=Hub Dashboard decision service (laya)

[Service]
ExecStart=$PY $HERE/laya_server.py
Environment=USE_TF=0
Environment=HF_HUB_OFFLINE=1
Restart=on-failure
Nice=5

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now hub-laya.service
echo "Done. The service starts with your login. Check it: curl -s http://127.0.0.1:8770/health"
