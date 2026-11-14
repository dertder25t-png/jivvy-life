#!/usr/bin/env python3
"""Hub Dashboard local helper (Firefox native messaging).

Firefox starts this program once per message, sends one JSON request on stdin and
reads one JSON reply on stdout, then it exits. Nothing keeps running in the background.

Requests:
  {"action": "ping"}
  {"action": "list_projects", "roots": ["/home/you/code"]}
  {"action": "launch", "prompt": "...", "cwd": "/home/you/code/app" | null, "plan": true}
  Predictive moves (shapes in docs/predictive-moves-contract.md):
  recent_files, reveal, move_files, undo_move, stage, discovered, mine
  {"action": "power"}  ->  {"ok": true, "on_battery": bool, "percent": 0-100 | null}   (/sys/class/power_supply)

Settings: ~/.config/hub-dashboard/helper.json
  allowed_roots  folders Claude Code may be started in (default: your home folder)
  terminal       command that opens a terminal; "{cwd}" is replaced by the folder
  claude         full path to the claude command (default: found automatically)

Set HUB_DRY_RUN=1 to print the command instead of running it.
HUB_DOWNLOADS overrides the Downloads folder (used by the tests).
"""
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import time
from pathlib import Path

HOME = Path.home()
CONFIG = Path(os.environ.get("XDG_CONFIG_HOME", HOME / ".config")) / "hub-dashboard" / "helper.json"
DEFAULTS = {
    "allowed_roots": [str(HOME)],
    "terminal": ["konsole", "--workdir", "{cwd}", "-e"],
    "claude": None,
}
MAX_PROMPT = 100_000
DATA = Path(os.environ.get("XDG_DATA_HOME", HOME / ".local/share")) / "hub-dashboard"
MINER = Path(__file__).resolve().parent / "pattern_miner.py"


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


POWER_DIR = Path(os.environ.get("HUB_POWER_DIR", "/sys/class/power_supply"))


def _read(p):
    try:
        return Path(p).read_text().strip()
    except OSError:
        return ""


def power(_msg, _cfg):
    """on_battery: a battery is discharging and no AC/mains supply is online (a desktop, with no
    battery, is never on battery). percent: capacity of the first battery, or null."""
    ac, bats = False, []
    try:
        supplies = sorted(POWER_DIR.iterdir())
    except OSError:
        supplies = []
    for d in supplies:
        kind = _read(d / "type").lower()
        if kind == "battery" or (not kind and d.name.upper().startswith("BAT")):
            bats.append(d)
        elif _read(d / "online") == "1":
            ac = True
    percent = None
    for d in bats:
        cap = _read(d / "capacity")
        if cap.isdigit():
            percent = min(100, int(cap))
            break
    discharging = any(_read(d / "status").lower() == "discharging" for d in bats)
    return {"ok": True, "on_battery": bool(bats) and not ac and discharging, "percent": percent}


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


# ---- Predictive moves -------------------------------------------------------------

def downloads_dir():
    """~/Downloads, or wherever xdg-user-dir says it is (HUB_DOWNLOADS wins, for tests)."""
    if os.environ.get("HUB_DOWNLOADS"):
        return os.path.realpath(os.environ["HUB_DOWNLOADS"])
    try:
        out = subprocess.run(["xdg-user-dir", "DOWNLOAD"], capture_output=True, text=True, timeout=5).stdout.strip()
        if out and out != str(HOME) and os.path.isdir(out):
            return os.path.realpath(out)
    except (OSError, subprocess.SubprocessError):
        pass
    return os.path.realpath(HOME / "Downloads")


def runtime_dir():
    """$XDG_RUNTIME_DIR/hub-dashboard (never /tmp). A snap's private runtime dir is skipped
    so the helper and the lifeboard-next shortcut always agree on one folder."""
    base = os.environ.get("XDG_RUNTIME_DIR")
    if base and os.path.basename(base.rstrip("/")).startswith("snap."):
        base = os.path.dirname(base.rstrip("/"))
    if not base or not os.path.isdir(base):
        return HOME / ".local/state/hub-dashboard"
    return Path(base) / "hub-dashboard"


def inside(path, roots):
    """True if path (resolved, symlinks followed) is one of roots or below one of them."""
    real = os.path.realpath(path)
    for root in roots:
        r = os.path.realpath(os.path.expanduser(root))
        if real == r or real.startswith(r.rstrip(os.sep) + os.sep):
            return True
    return False


def is_allowed_file(path, cfg, extra=()):
    """File-level is_allowed(): an existing regular file inside allowed_roots or extra."""
    return os.path.isfile(os.path.realpath(path)) and inside(path, list(cfg["allowed_roots"]) + list(extra))


def bad_name(name):
    """Why a requested file name isn't a plain name in Downloads, or None if it is fine."""
    if not isinstance(name, str) or not name or len(name) > 255:
        return "bad name"
    if "/" in name or "\0" in name or ".." in name or name.startswith("."):
        return "not a plain file name"
    return None


def free_name(folder, name):
    """name, or "name (1).ext", "name (2).ext"... whichever doesn't exist yet in folder."""
    stem, ext = os.path.splitext(name)
    for i in range(1000):
        cand = os.path.join(folder, name if i == 0 else f"{stem} ({i}){ext}")
        if not os.path.lexists(cand):
            return cand
    raise FileExistsError(name)


def move_no_clobber(src, dst):
    """Move a file without ever replacing dst: a hard link fails if dst exists (atomic);
    across file systems the copy is opened with O_EXCL for the same guarantee."""
    try:
        os.link(src, dst)
    except FileExistsError:
        raise
    except OSError:  # other file system, or no hard links there
        fd = os.open(dst, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with open(src, "rb") as fin, os.fdopen(fd, "wb") as fout:
                shutil.copyfileobj(fin, fout)
            shutil.copystat(src, dst)
        except BaseException:
            os.unlink(dst)
            raise
    os.unlink(src)


def file_info(path, st):
    return {"name": os.path.basename(path), "path": path, "size": st.st_size, "mtime": int(st.st_mtime * 1000)}


def recent_files(msg, _cfg):
    """Files in Downloads changed in the last `minutes`, newest first (read-only)."""
    folder = downloads_dir()
    minutes = min(max(float(msg.get("minutes") or 30), 1), 7 * 24 * 60)
    exts = {str(e).lower().lstrip(".") for e in (msg.get("exts") or []) if isinstance(e, str)}
    since = time.time() - minutes * 60
    files = []
    try:
        entries = list(os.scandir(folder))
    except OSError as e:
        return {"ok": False, "error": f"can't read {folder}: {e.strerror}"}
    for ent in entries:
        name = ent.name
        if name.startswith(".") or name.endswith((".part", ".crdownload")):
            continue  # hidden, or a download still in progress
        if exts and os.path.splitext(name)[1].lower().lstrip(".") not in exts:
            continue
        try:
            if not ent.is_file(follow_symlinks=False):
                continue
            st = ent.stat(follow_symlinks=False)
        except OSError:
            continue
        if st.st_mtime >= since:
            files.append(file_info(ent.path, st))
    files.sort(key=lambda f: f["mtime"], reverse=True)
    return {"ok": True, "dir": folder, "files": files[:20]}


def reveal(msg, cfg):
    """Show a file in Dolphin (selected), or open its folder with xdg-open."""
    path = msg.get("path")
    if not isinstance(path, str) or not path:
        return {"ok": False, "error": "no path"}
    real = os.path.realpath(os.path.expanduser(path))
    if not os.path.exists(real) or not inside(real, list(cfg["allowed_roots"]) + [downloads_dir()]):
        return {"ok": False, "error": "path not allowed"}
    if shutil.which("dolphin"):
        argv = ["dolphin", "--select", real]
    else:
        argv = ["xdg-open", real if os.path.isdir(real) else os.path.dirname(real)]
    if os.environ.get("HUB_DRY_RUN"):
        return {"ok": True, "dry_run": True, "argv": argv}
    subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                     stderr=subprocess.DEVNULL, start_new_session=True)
    return {"ok": True}


def move_files(msg, cfg):
    """Move named files out of Downloads into dest. Never overwrites; reports each skip."""
    folder = downloads_dir()
    dest = msg.get("dest")
    if not isinstance(dest, str) or not dest:
        return {"ok": False, "error": "no destination"}
    dest = os.path.realpath(os.path.expanduser(dest))
    if not os.path.isdir(dest) or not inside(dest, cfg["allowed_roots"]):
        return {"ok": False, "error": f"destination not allowed: {dest} (see allowed_roots in {CONFIG})"}
    if dest == folder:
        return {"ok": False, "error": "destination is the Downloads folder"}
    names = msg.get("names")
    if not isinstance(names, list) or len(names) > 200:
        return {"ok": False, "error": "names must be a list"}
    pairs, skipped = [], []
    for name in names:
        why = bad_name(name)
        src = os.path.join(folder, name) if not why else None
        if not why and (os.path.islink(src) or not os.path.isfile(src)):
            why = "not found"
        if why:
            skipped.append({"name": str(name)[:255], "why": why})
            continue
        try:
            dst = free_name(dest, name)
            move_no_clobber(src, dst)
            pairs.append([src, dst])
        except OSError as e:
            skipped.append({"name": name, "why": e.strerror or type(e).__name__})
    return {"ok": True, "pairs": pairs, "skipped": skipped}


def undo_move(msg, cfg):
    """Put moved files back: `to` goes back to `from` only if `from` is still free."""
    folder = downloads_dir()
    pairs, skipped = [], []
    for pair in (msg.get("pairs") or [])[:200]:
        if not (isinstance(pair, list) and len(pair) == 2 and all(isinstance(p, str) and p for p in pair)):
            skipped.append({"name": str(pair)[:255], "why": "bad pair"})
            continue
        frm, to = pair
        name = os.path.basename(frm)
        if (bad_name(name) or os.path.realpath(os.path.dirname(frm)) != folder
                or not is_allowed_file(to, cfg) or os.path.islink(to)):
            skipped.append({"name": name, "why": "not allowed"})
        elif os.path.lexists(frm):
            skipped.append({"name": name, "why": "a file with that name is back in Downloads"})
        else:
            try:
                move_no_clobber(to, os.path.join(folder, name))
                pairs.append([frm, to])
            except OSError as e:
                skipped.append({"name": name, "why": e.strerror or type(e).__name__})
    return {"ok": True, "pairs": pairs, "skipped": skipped}


def write_private(path, obj):
    """Write JSON as mode 600 (dir 700), replacing the old file in one step."""
    path = Path(path)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    tmp = path.with_name(f".{path.name}.{os.getpid()}")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(obj, f)
    os.replace(tmp, path)


def take_fired(folder):
    """Return the {move, t} lines lifeboard-next appended, and clear them."""
    src, grab = folder / "fired.jsonl", folder / f".fired.{os.getpid()}"
    try:
        os.rename(src, grab)  # lifeboard-next then starts a new file; no line is lost
    except FileNotFoundError:
        return []
    fired = []
    try:
        for line in grab.read_text().splitlines():
            try:
                e = json.loads(line)
                if isinstance(e, dict) and isinstance(e.get("move"), str):
                    fired.append({"move": e["move"][:80], "t": e.get("t")})
            except ValueError:
                pass
    finally:
        grab.unlink()
    return fired[-100:]


def stage(msg, _cfg):
    """Publish the top staged move for the Meta+Shift+. shortcut (only open/ask with a web URL)."""
    folder = runtime_dir()
    target = folder / "next_move.json"
    item = msg.get("move")
    action = item.get("action") if isinstance(item, dict) else None
    url = None
    if isinstance(action, dict) and action.get("type") in ("open", "ask"):
        url = item.get("url") or action.get("url")
    if isinstance(url, str) and re.match(r"https?://", url) and len(url) < 8192:
        def num(v, d):
            return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else d
        write_private(target, {
            "move": str(item.get("move") or "")[:80],
            "label": str(item.get("label") or "")[:200],
            "confidence": num(item.get("confidence"), 0.0),
            "threshold": num(item.get("threshold"), 0.85),
            "url": url,
            "expires": item.get("expires") if isinstance(item.get("expires"), (int, float)) else None,
        })
    else:
        try:
            target.unlink()
        except FileNotFoundError:
            pass
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    return {"ok": True, "fired": take_fired(folder)}


def read_json(path):
    try:
        data = json.loads(Path(path).read_text())
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def discovered(_msg, _cfg):
    """The miner's output plus the local seed, seed values under mined ones."""
    disc, seed = read_json(DATA / "discovered_moves.json"), read_json(DATA / "seed_local.json")
    if disc is None and seed is None:
        return {"ok": False, "error": "nothing mined yet"}
    disc, seed = disc or {}, seed or {}

    def both(key):
        a, b = seed.get(key), disc.get(key)
        return {**(a if isinstance(a, dict) else {}), **(b if isinstance(b, dict) else {})}

    learned = {
        "t": disc.get("t") or seed.get("t"),
        "navAliases": both("navAliases"),
        "canvasCourses": both("canvasCourses"),
        "counts": disc.get("counts") if isinstance(disc.get("counts"), dict) else {},
        "discovered": disc.get("discovered") if isinstance(disc.get("discovered"), list) else [],
    }
    if isinstance(seed.get("name"), str):
        learned["name"] = seed["name"]
    return {"ok": True, "learned": learned}


def mine(msg, cfg):
    """Run the pattern miner now (the drawer's "Scan now"), then return what it found."""
    try:
        r = subprocess.run([sys.executable, "-I", str(MINER)], capture_output=True, text=True, timeout=120)
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "miner took longer than 120 s"}
    if r.returncode != 0:
        return {"ok": False, "error": (r.stderr.strip().splitlines() or ["miner failed"])[-1][:300]}
    return discovered(msg, cfg)


ACTIONS = {"ping": ping, "power": power, "list_projects": list_projects, "launch": launch,
           "recent_files": recent_files, "reveal": reveal, "move_files": move_files,
           "undo_move": undo_move, "stage": stage, "discovered": discovered, "mine": mine}


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
