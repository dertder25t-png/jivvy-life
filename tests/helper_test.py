# Run: python3 -I tests/helper_test.py   (uses HUB_DRY_RUN, launches nothing; all files in a temp folder)
import json, os, shutil, stat, struct, subprocess, sys, tempfile, time
from pathlib import Path
TMP = Path(tempfile.mkdtemp())
(TMP / "hub-dashboard").mkdir()
DL, ASSETS, OUTSIDE, DATA, RUN = TMP / "dl", TMP / "roots" / "assets", TMP / "outside", TMP / "data", TMP / "run"
for d in (DL, ASSETS, OUTSIDE, DATA / "hub-dashboard", RUN):
    d.mkdir(parents=True)
home = str(Path.home())
(TMP / "hub-dashboard" / "helper.json").write_text(json.dumps({"claude": "/bin/true", "allowed_roots": [home, str(TMP / "roots")]}))
HERE = Path(__file__).resolve().parent.parent / "helper"
HOST, NEXT = HERE / "hub_helper.py", HERE / "lifeboard-next"
ENV = {**os.environ, "HUB_DRY_RUN": "1", "XDG_CONFIG_HOME": str(TMP), "HUB_DOWNLOADS": str(DL),
       "XDG_DATA_HOME": str(DATA), "XDG_RUNTIME_DIR": str(RUN)}

def call(msg):
    data = json.dumps(msg).encode()
    out = subprocess.run([sys.executable, str(HOST)], input=struct.pack("<I", len(data)) + data,
                         capture_output=True, env=ENV, check=True).stdout
    (n,) = struct.unpack("<I", out[:4])
    return json.loads(out[4:4 + n])

def touch(path, text="x", age=0):
    path.write_text(text)
    t = time.time() - age
    os.utime(path, (t, t))

def mode(p):
    return stat.S_IMODE(os.stat(p).st_mode)

results = []

def check(name, res, ok):
    """Judge right away: later steps change the files."""
    try:
        good = bool(ok(res))
    except Exception as e:
        good, res = False, {"check error": repr(e), **res}
    results.append((name, res, good))

for args in [
    ("ping", call({"action": "ping"}), lambda r: r["ok"]),
    ("launch plan", call({"action": "launch", "prompt": "add $(rm -rf ~); dark mode", "cwd": home, "plan": True}),
     lambda r: (r["argv"][-1] == "add $(rm -rf ~); dark mode" and "plan" in r["argv"])),
    ("dash prompt", call({"action": "launch", "prompt": "-p hi", "cwd": home, "plan": False}),
     lambda r: r["argv"][-2:] == ["--", "-p hi"]),
    ("outside allowed", call({"action": "launch", "prompt": "x", "cwd": "/etc"}), lambda r: not r["ok"]),
    ("empty prompt", call({"action": "launch", "prompt": "  "}), lambda r: not r["ok"]),
    ("unknown", call({"action": "nope"}), lambda r: not r["ok"]),
    ("list", call({"action": "list_projects", "roots": [home]}), lambda r: r["ok"]),
]:
    check(*args)

# power: AC online / battery status and capacity from a fake /sys/class/power_supply
def supply(name, **files):
    d = TMP / "power" / name; d.mkdir(parents=True, exist_ok=True)
    for k, v in files.items(): (d / k).write_text(str(v) + "\n")
supply("AC", type="Mains", online=0); supply("BAT0", type="Battery", status="Discharging", capacity=37)
supply("usb0", type="USB", online=0, status="Discharging")  # a USB source's own status is not the battery's
ENV["HUB_POWER_DIR"] = str(TMP / "power")
check("power: on battery", call({"action": "power"}), lambda r: r == {"ok": True, "on_battery": True, "percent": 37})
supply("AC", online=1); supply("BAT0", status="Charging")
check("power: on AC", call({"action": "power"}), lambda r: r["ok"] and r["on_battery"] is False and r["percent"] == 37)
supply("AC", online=0); supply("BAT0", status="Full", capacity=100)
check("power: full and unplugged is not discharging", call({"action": "power"}), lambda r: r["on_battery"] is False and r["percent"] == 100)
ENV["HUB_POWER_DIR"] = str(TMP / "nothing")
check("power: no supplies (desktop)", call({"action": "power"}), lambda r: r == {"ok": True, "on_battery": False, "percent": None})

# recent_files: by extension and age, newest first; partial downloads skipped
touch(DL / "new.tif", age=60); touch(DL / "newer.jpg", age=5); touch(DL / "old.tif", age=3 * 3600)
touch(DL / "notes.txt", age=10); touch(DL / "big.tif.part", age=1)
check("recent_files ext+age", call({"action": "recent_files", "minutes": 30, "exts": ["tif", ".JPG"]}),
      lambda r: r["ok"] and [f["name"] for f in r["files"]] == ["newer.jpg", "new.tif"])

# reveal: inside Downloads gives the argv; outside is refused
check("reveal", call({"action": "reveal", "path": str(DL / "new.tif")}),
      lambda r: r["ok"] and (r["argv"][-1].endswith("new.tif") or r["argv"][-1] == str(DL)))
check("reveal outside", call({"action": "reveal", "path": "/etc/passwd"}), lambda r: not r["ok"])

# move_files: refuses bad dests and names, never overwrites
check("move dest outside", call({"action": "move_files", "names": ["new.tif"], "dest": str(OUTSIDE)}),
      lambda r: not r["ok"] and (DL / "new.tif").exists())
check("move dest missing", call({"action": "move_files", "names": ["new.tif"], "dest": str(ASSETS / "nope")}),
      lambda r: not r["ok"])
touch(OUTSIDE / "secret.txt")
bad = call({"action": "move_files", "names": ["../outside/secret.txt", "a/b", "..", ".hidden", "ghost.jpg"], "dest": str(ASSETS)})
check("move bad names", bad, lambda r: r["ok"] and not r["pairs"] and len(r["skipped"]) == 5
      and (OUTSIDE / "secret.txt").exists())
touch(ASSETS / "new.tif", text="keep me")
moved = call({"action": "move_files", "names": ["new.tif", "newer.jpg"], "dest": str(ASSETS)})
check("move no overwrite", moved, lambda r: r["ok"] and len(r["pairs"]) == 2
      and (ASSETS / "new.tif").read_text() == "keep me" and (ASSETS / "new (1).tif").exists()
      and not (DL / "new.tif").exists())

# undo_move: puts them back; refuses a pair pointing outside, and never overwrites
touch(DL / "newer.jpg", text="came back")  # a new file with the same name: that pair must be skipped
undo = call({"action": "undo_move", "pairs": moved["pairs"] + [[str(DL / "x.txt"), str(OUTSIDE / "secret.txt")]]})
check("undo_move", undo, lambda r: r["ok"] and len(r["pairs"]) == 1 and len(r["skipped"]) == 2
      and (DL / "new.tif").exists() and (DL / "newer.jpg").read_text() == "came back"
      and (OUTSIDE / "secret.txt").exists() and not (DL / "x.txt").exists())

# stage: 600 file in a 700 folder; returns and clears fired.jsonl; non-URL moves delete the file
hub = RUN / "hub-dashboard"
item = {"id": "a1", "move": "nav_shortcut_interceptor", "label": "Drive", "confidence": 0.95, "threshold": 0.85,
        "t": 1, "expires": None, "action": {"type": "open", "url": "https://drive.google.com/"}, "source": "rule"}
r1 = call({"action": "stage", "move": item})
staged = json.loads((hub / "next_move.json").read_text())
check("stage writes 600", r1, lambda r: r["ok"] and r["fired"] == [] and mode(hub / "next_move.json") == 0o600
      and mode(hub) == 0o700 and staged["url"] == "https://drive.google.com/")

def next_move(*args):
    return json.loads(subprocess.run([sys.executable, "-I", str(NEXT), *args], env=ENV,
                                     capture_output=True, text=True, check=True).stdout)
check("next dry-run fires", next_move("--dry-run"), lambda r: r["fire"] and r["url"] == staged["url"])
call({"action": "stage", "move": {**item, "confidence": 0.6}})
check("next below threshold", next_move("--dry-run"), lambda r: not r["fire"])
call({"action": "stage", "move": {**item, "expires": 1000}})
check("next expired", next_move("--dry-run"), lambda r: not r["fire"])
call({"action": "stage", "move": {**item, "action": {"type": "open", "url": "file:///etc/passwd"}}})
check("stage non-web deletes", {}, lambda r: not (hub / "next_move.json").exists())
(hub / "fired.jsonl").write_text(json.dumps({"move": "nav_shortcut_interceptor", "t": 5}) + "\nnot json\n")
check("stage returns fired", call({"action": "stage", "move": None}),
      lambda r: r["fired"] == [{"move": "nav_shortcut_interceptor", "t": 5}] and not (hub / "fired.jsonl").exists())

# discovered: none yet, then seed values under mined ones
check("discovered empty", call({"action": "discovered"}), lambda r: not r["ok"])
(DATA / "hub-dashboard" / "seed_local.json").write_text(json.dumps(
    {"t": 1, "navAliases": {"drive": "https://seed/", "keep": "https://keep.google.com/"}, "name": "Sam", "unmatched": []}))
(DATA / "hub-dashboard" / "discovered_moves.json").write_text(json.dumps(
    {"t": 2, "navAliases": {"drive": "https://drive.google.com/"}, "canvasCourses": {"1": {"name": "Art", "exts": ["pdf"]}},
     "counts": {"canvas_study_bridge": {"n": 3, "note": "x"}}, "discovered": []}))
check("discovered merge", call({"action": "discovered"}),
      lambda r: r["ok"] and r["learned"]["navAliases"] == {"drive": "https://drive.google.com/", "keep": "https://keep.google.com/"}
      and r["learned"]["name"] == "Sam" and r["learned"]["canvasCourses"]["1"]["name"] == "Art")

bad = 0
for name, res, good in results:
    bad += not good
    print(("ok  " if good else "FAIL"), name, json.dumps(res)[:160])
shutil.rmtree(TMP)
sys.exit(bad)
