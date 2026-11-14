#!/usr/bin/env python3
"""Hub Dashboard decision service: asks a laya model where a request should go.

Keeps the model loaded and answers on 127.0.0.1 only. The dashboard calls it when you
press Enter and its own quick model isn't sure, to decide between Google and an AI chat.

  POST /decide  {"text": "..."}  ->  {"ok": true, "p_ai": 0.62, "probs": {"google": 0.38, "ai": 0.62}, "ms": 350}
  GET  /health                   ->  {"ok": true, "model": "...", "ready": true}

Only the dashboard extension may call it: requests must come from a moz-extension:// page
and be addressed to 127.0.0.1 / localhost (blocks other websites and DNS rebinding).

Settings: ~/.config/hub-dashboard/laya.json
  model  "vega" (default): laya's 0.8B reader, trained in about 2 minutes on tools/seed.jsonl
         plus ~/.config/hub-dashboard/labels.jsonl if you add one ({"text": ..., "cls": "search"|"ask"} per line).
         The training is saved and redone only when those files change.
         Or a laya checkpoint id, e.g. "convaiinnovations/laya-typed-decisions" (no training).
  port   default 8770
  threads  CPU threads for the model (default 8; all 16 made training several times slower here)

On 30 typical searches, with the dashboard's own classifier deciding the clear ones:
vega trained 97%, laya-typed-decisions 93%, classifier alone 90%.
"""
import hashlib
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

os.environ.setdefault("USE_TF", "0")  # the model card: TensorFlow probing can hang laya.load()

CFG_DIR = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "hub-dashboard"
CONFIG = CFG_DIR / "laya.json"
DATA = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share")) / "hub-dashboard"
LABEL_FILES = [Path(__file__).resolve().parent.parent / "tools" / "seed.jsonl", CFG_DIR / "labels.jsonl"]
DEFAULTS = {"model": "vega", "port": 8770, "threads": 8}
MAX_TEXT = 4000

# The one typed decision. Two options measured best: on 30 typical searches, asking
# "Google or AI" beat a four-way choice and a yes/no question.
QUESTIONS = {
    "destination": {
        "type": "choice",
        "instructions": "A person typed this into their browser. Should it go to Google search or to an AI assistant?",
        "criteria": {
            "google": "look up a fact, place, product, price, website, news, weather, scores or hours",
            "ai": "explain, reason, write, rewrite, plan, brainstorm, advise, solve or translate",
        },
    }
}


def load_config():
    cfg = dict(DEFAULTS)
    try:
        cfg.update(json.loads(CONFIG.read_text()))
    except FileNotFoundError:
        pass
    return cfg


class Model:
    def __init__(self, name, threads=8):
        self.name = name
        self.threads = threads
        self.agent = None
        self.error = None
        self.lock = threading.Lock()

    def load(self):
        try:
            import laya
            import torch
            torch.set_num_threads(int(self.threads))
            t = time.perf_counter()
            if self.name == "vega":
                agent = laya.Agent(vegaml=True)
                self._train(agent)
            else:
                agent = laya.load(self.name)
            agent.predict("warm up", QUESTIONS)  # first call builds caches
            self.agent = agent  # only now does /health say ready
            print(f"laya ready: {self.name} in {time.perf_counter() - t:.1f}s", flush=True)
        except Exception as e:
            self.error = f"{type(e).__name__}: {e}"
            print("laya failed to load:", self.error, file=sys.stderr, flush=True)

    def _train(self, agent):
        """Fits vega's answer head on the example files, or reloads the saved fit if they haven't changed."""
        rows, h = [], hashlib.sha256(json.dumps(QUESTIONS, sort_keys=True).encode())
        for f in LABEL_FILES:
            if not f.exists():
                continue
            for line in f.read_text().splitlines():
                if not line.strip():
                    continue
                ex = json.loads(line)
                rows.append({"state": ex["text"], "gold": {"destination": "google" if ex["cls"] == "search" else "ai"}})
                h.update(line.encode())
        saved = DATA / "vega-fit"
        stamp = saved / "labels.sha256"
        if stamp.exists() and stamp.read_text() == h.hexdigest():
            agent.load_calibration(str(saved))
            print(f"loaded saved training ({len(rows)} examples)", flush=True)
            return
        t = time.perf_counter()
        agent.fit(rows, questions=QUESTIONS)
        saved.mkdir(parents=True, exist_ok=True)
        agent.save_calibration(str(saved))
        stamp.write_text(h.hexdigest())
        print(f"trained on {len(rows)} examples in {time.perf_counter() - t:.0f}s", flush=True)

    def decide(self, text):
        t = time.perf_counter()
        with self.lock:  # one forward pass at a time
            out = self.agent.predict(text, QUESTIONS)
        probs = {k: float(v) for k, v in out["answers"]["destination"]["probabilities"].items()}
        p_ai = probs.get("ai", 0.0)
        return {"ok": True, "p_ai": round(p_ai, 4), "probs": probs,
                "ms": round((time.perf_counter() - t) * 1000, 1)}


def make_handler(model, port):
    hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}

    class Handler(BaseHTTPRequestHandler):
        def _reply(self, code, obj):
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _allowed(self):
            origin = self.headers.get("Origin", "")
            return self.headers.get("Host") in hosts and (origin == "" or origin.startswith("moz-extension://"))

        def do_GET(self):
            if not self._allowed():
                return self._reply(403, {"ok": False, "error": "forbidden"})
            if self.path == "/health":
                return self._reply(200, {"ok": model.error is None, "model": model.name,
                                         "ready": model.agent is not None, "error": model.error})
            self._reply(404, {"ok": False, "error": "not found"})

        def do_POST(self):
            # Browsers always send Origin on POST, so a web page can't pass as the extension.
            if not self._allowed() or not self.headers.get("Origin", "").startswith("moz-extension://"):
                return self._reply(403, {"ok": False, "error": "forbidden"})
            if self.path != "/decide":
                return self._reply(404, {"ok": False, "error": "not found"})
            try:
                n = int(self.headers.get("Content-Length", "0"))
                if n > 64_000:
                    return self._reply(413, {"ok": False, "error": "too long"})
                text = str(json.loads(self.rfile.read(n) or b"{}").get("text", "")).strip()[:MAX_TEXT]
            except Exception:
                return self._reply(400, {"ok": False, "error": "bad request"})
            if not text:
                return self._reply(400, {"ok": False, "error": "empty text"})
            if model.agent is None:
                return self._reply(503, {"ok": False, "error": model.error or "still loading"})
            try:
                self._reply(200, model.decide(text))
            except Exception as e:
                self._reply(500, {"ok": False, "error": f"{type(e).__name__}: {e}"})

        def log_message(self, *_):
            pass  # never log what you typed

    return Handler


def main():
    cfg = load_config()
    if len(sys.argv) > 1:  # quick test: laya_server.py "some text"
        m = Model(cfg["model"], cfg["threads"])
        m.load()
        for text in sys.argv[1:]:
            print(json.dumps({"text": text, **m.decide(text)}))
        return
    model = Model(cfg["model"], cfg["threads"])
    threading.Thread(target=model.load, daemon=True).start()
    port = int(cfg["port"])
    server = ThreadingHTTPServer(("127.0.0.1", port), make_handler(model, port))
    print(f"listening on http://127.0.0.1:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
