#!/usr/bin/env python3
"""Scores helper/workflow_benchmark.json. A case counts when next_move matches and should_stage agrees.

  workflow_benchmark_run.py              in-process (loads laya and the saved workflow fit)
  workflow_benchmark_run.py --http       POST /workflow on the running hub-laya, token from ~/.config/hub-dashboard/laya-token
Add --device cpu|cuda|auto for the in-process run (default cpu, like the service).
"""
import json
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import laya_server as ls  # noqa: E402


def run(ask, bench):
    got = 0
    for c in bench["cases"]:
        r = ask(c["state"], bench["moves"])
        nm, st = r["next_move"]["choice"], r["should_stage"]["choice"] == "yes"
        ok = nm == c["next_move"] and st == c["should_stage"]
        got += ok
        print(f"{'ok  ' if ok else 'MISS'} {c['id']:<18} want {c['next_move']}/{c['should_stage']}  "
              f"got {nm} p={r['next_move']['p']}/{st}")
    print(f"{got}/{len(bench['cases'])}")
    return got


def main(argv):
    bench = json.loads((HERE / "workflow_benchmark.json").read_text())
    if "--http" in argv:
        tok = ls.read_token()
        port = int(ls.load_config()["port"])

        def ask(state, moves):
            req = urllib.request.Request(f"http://127.0.0.1:{port}/workflow", method="POST",
                                         data=json.dumps({"state": state, "moves": moves}).encode(),
                                         headers={"Content-Type": "application/json", "X-Hub-Token": tok or ""})
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read())
    else:
        dev = argv[argv.index("--device") + 1] if "--device" in argv else "cpu"
        m = ls.Model("vega", 8, dev)
        m.load()
        if m.agent is None:
            print("load failed:", m.error)
            return 2
        ask = lambda state, moves: m.workflow(ls.state_text(state), moves)
    t = time.perf_counter()
    got = run(ask, bench)
    print(f"{time.perf_counter() - t:.1f}s")
    return 0 if got == len(bench["cases"]) else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
