# Run: python3 -I tests/helper_test.py   (uses HUB_DRY_RUN, launches nothing)
import json, os, struct, subprocess, sys, tempfile
from pathlib import Path
TMP = tempfile.mkdtemp()
(Path(TMP) / "hub-dashboard").mkdir()
(Path(TMP) / "hub-dashboard" / "helper.json").write_text(json.dumps({"claude": "/bin/true"}))
HOST = Path(__file__).resolve().parent.parent / "helper" / "hub_helper.py"

def call(msg):
    data = json.dumps(msg).encode()
    out = subprocess.run([sys.executable, str(HOST)], input=struct.pack("<I", len(data)) + data,
                         capture_output=True, env={**os.environ, "HUB_DRY_RUN": "1", "XDG_CONFIG_HOME": TMP}, check=True).stdout
    (n,) = struct.unpack("<I", out[:4])
    return json.loads(out[4:4 + n])

home = str(Path.home())
checks = [
    ("ping", call({"action": "ping"}), lambda r: r["ok"]),
    ("launch plan", call({"action": "launch", "prompt": "add $(rm -rf ~); dark mode", "cwd": home, "plan": True}),
     lambda r: (r["argv"][-1] == "add $(rm -rf ~); dark mode" and "plan" in r["argv"])),
    ("dash prompt", call({"action": "launch", "prompt": "-p hi", "cwd": home, "plan": False}),
     lambda r: r["argv"][-2:] == ["--", "-p hi"]),
    ("outside allowed", call({"action": "launch", "prompt": "x", "cwd": "/etc"}), lambda r: not r["ok"]),
    ("empty prompt", call({"action": "launch", "prompt": "  "}), lambda r: not r["ok"]),
    ("unknown", call({"action": "nope"}), lambda r: not r["ok"]),
    ("list", call({"action": "list_projects", "roots": [home]}), lambda r: r["ok"]),
]
bad = 0
for name, res, ok in checks:
    good = ok(res); bad += not good
    print(("ok  " if good else "FAIL"), name, json.dumps(res)[:160])
sys.exit(bad)
