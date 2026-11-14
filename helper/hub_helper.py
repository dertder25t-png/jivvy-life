#!/usr/bin/env python3
"""Hub Dashboard local helper (Firefox native messaging).

Firefox starts this program once per message, sends one JSON request on stdin and
reads one JSON reply on stdout, then it exits. Nothing keeps running in the background.

Requests:
  {"action": "ping"}
  {"action": "list_projects", "roots": ["/home/you/code"]}
  {"action": "launch", "prompt": "...", "cwd": "/home/you/code/app" | null, "plan": true}

Settings: ~/.config/hub-dashboard/helper.json
  allowed_roots  folders Claude Code may be started in (default: your home folder)
  terminal       command that opens a terminal; "{cwd}" is replaced by the folder
  claude         full path to the claude command (default: found automatically)

Set HUB_DRY_RUN=1 to print the command instead of running it.
"""
import json
import os
import shutil
import struct
import subprocess
import sys
from pathlib import Path

HOME = Path.home()
CONFIG = Path(os.environ.get("XDG_CONFIG_HOME", HOME / ".config")) / "hub-dashboard" / "helper.json"
DEFAULTS = {
    "allowed_roots": [str(HOME)],
    "terminal": ["konsole", "--workdir", "{cwd}", "-e"],
    "claude": None,
}
MAX_PROMPT = 100_000


def load_config():
    cfg = dict(DEFAULTS)
    try:
        cfg.update(json.loads(CONFIG.read_text()))
    except FileNotFoundError:
        pass
    except Exception as e:  # bad JSON: keep defaults, report it on ping
        cfg["config_error"] = str(e)
    return cfg


def read_message():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    (n,) = struct.unpack("<I", raw)
    return json.loads(sys.stdin.buffer.read(n).decode("utf-8"))


def send(obj):
    data = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)) + data)
    sys.stdout.buffer.flush()


def find_claude(cfg):
    if cfg.get("claude"):
        return cfg["claude"] if os.access(cfg["claude"], os.X_OK) else None
    found = shutil.which("claude")
    if found:
        return found
    for p in (HOME / ".local/bin/claude", HOME / ".claude/local/claude",
              HOME / ".local/share/node/bin/claude", Path("/usr/local/bin/claude")):
        if os.access(p, os.X_OK):
            return str(p)
    return None


def is_allowed(path, cfg):
    real = os.path.realpath(path)
    if not os.path.isdir(real):
        return False
    for root in cfg["allowed_roots"]:
        r = os.path.realpath(os.path.expanduser(root))
        if real == r or real.startswith(r.rstrip(os.sep) + os.sep):
            return True
    return False


def ping(_msg, cfg):
    out = {"ok": True, "claude": find_claude(cfg), "terminal": cfg["terminal"][0]}
    if "config_error" in cfg:
        out["config_error"] = cfg["config_error"]
    return out


def list_projects(msg, cfg):
    projects = []
    for root in msg.get("roots") or []:
        root = os.path.expanduser(str(root))
        if not is_allowed(root, cfg):
            continue
        try:
            children = sorted(Path(root).iterdir())
        except OSError:
            continue
        for child in children:
            if child.is_dir() and (child / ".git").exists():
                projects.append({"name": child.name, "path": str(child)})
            if len(projects) >= 300:
                break
    return {"ok": True, "projects": projects}


def launch(msg, cfg):
    prompt = msg.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        return {"ok": False, "error": "empty prompt"}
    if len(prompt) > MAX_PROMPT:
        return {"ok": False, "error": "prompt too long"}
    cwd = msg.get("cwd") or str(HOME)
    if not is_allowed(cwd, cfg):
        return {"ok": False, "error": f"folder not allowed: {cwd} (see allowed_roots in {CONFIG})"}
    cwd = os.path.realpath(cwd)
    claude = find_claude(cfg)
    if not claude:
        return {"ok": False, "error": "claude command not found"}

    # Every piece is its own argument: nothing goes through a shell.
    argv = [part.replace("{cwd}", cwd) for part in cfg["terminal"]] + [claude]
    if msg.get("plan", True):
        argv += ["--permission-mode", "plan"]
    if prompt.startswith("-"):
        argv.append("--")  # so a prompt like "-x" isn't read as an option
    argv.append(prompt)

    if os.environ.get("HUB_DRY_RUN"):
        return {"ok": True, "dry_run": True, "argv": argv}
    subprocess.Popen(argv, cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                     stderr=subprocess.DEVNULL, start_new_session=True)
    return {"ok": True}


ACTIONS = {"ping": ping, "list_projects": list_projects, "launch": launch}


def main():
    try:
        msg = read_message()
        if msg is None:
            return
        handler = ACTIONS.get(msg.get("action"))
        send(handler(msg, load_config()) if handler else {"ok": False, "error": "unknown action"})
    except Exception as e:
        send({"ok": False, "error": f"{type(e).__name__}: {e}"})


if __name__ == "__main__":
    main()
