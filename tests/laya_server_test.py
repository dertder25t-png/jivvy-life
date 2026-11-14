# Run: python3 -I tests/laya_server_test.py   (fake model; checks the HTTP guard and reply shape)
import json, sys, threading, urllib.request, urllib.error
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "helper"))
import laya_server as ls

class FakeAgent:
    def predict(self, state, questions):
        assert "destination" in questions
        return {"answers": {"destination": {"choice": "ai", "probabilities": {"google": 0.2, "ai": 0.8}}}}

m = ls.Model("fake"); m.agent = FakeAgent()
srv = ls.ThreadingHTTPServer(("127.0.0.1", 0), ls.make_handler(m, 0))
port = srv.server_address[1]
srv.RequestHandlerClass = ls.make_handler(m, port)
threading.Thread(target=srv.serve_forever, daemon=True).start()

def call(path, body=None, origin=None, host=None):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=None if body is None else json.dumps(body).encode())
    if origin: req.add_header("Origin", origin)
    if host: req.add_header("Host", host)
    try:
        with urllib.request.urlopen(req) as r: return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read())

fail = 0
def check(name, ok):
    global fail; fail += not ok; print(("ok  " if ok else "FAIL"), name)

ext = "moz-extension://abc"
s, r = call("/decide", {"text": "explain wifi"}, ext); check("extension gets an answer", s == 200 and r["p_ai"] == 0.8)
check("website is refused", call("/decide", {"text": "x"}, "https://evil.example")[0] == 403)
check("no origin POST is refused", call("/decide", {"text": "x"})[0] == 403)
check("other Host (DNS rebinding) is refused", call("/decide", {"text": "x"}, ext, host=f"evil.example:{port}")[0] == 403)
check("empty text is rejected", call("/decide", {"text": " "}, ext)[0] == 400)
check("health works", call("/health")[1]["ready"] is True)
m.agent = None
check("not loaded gives 503", call("/decide", {"text": "x"}, ext)[0] == 503)
print(f"{fail} failed" if fail else "all passed"); sys.exit(1 if fail else 0)
