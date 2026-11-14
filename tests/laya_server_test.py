# Run: python3 -I tests/laya_server_test.py   (fake model; checks the HTTP guard and reply shape)
import json, os, sys, tempfile, threading, urllib.request, urllib.error
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "helper"))
import laya_server as ls

seen = {}
class FakeAgent:
    def predict(self, state, questions):
        if "destination" in questions:
            assert set(questions) == {"destination"}
            return {"answers": {"destination": {"choice": "ai", "probabilities": {"google": 0.2, "ai": 0.8}}}}
        assert set(questions) == {"should_stage", "next_move"}
        seen["criteria"] = questions["next_move"]["criteria"]; seen["state"] = state; seen["n"] = seen.get("n", 0) + 1
        labels = list(seen["criteria"])
        probs = {k: (0.9 if k == labels[0] else 0.1 / (len(labels) - 1)) for k in labels} if len(labels) > 1 else {labels[0]: 1.0}
        return {"answers": {"should_stage": {"type": "noul", "noul": 0.9, "probabilities": {"false": 0.1, "true": 0.9}, "route": "auto"},
                            "next_move": {"type": "choice", "choice": labels[0], "probabilities": probs, "route": "auto"}}}

class UntrainedAgent:
    def predict(self, state, questions):
        if "destination" not in questions: raise KeyError("should_stage")
        return FakeAgent().predict(state, questions)

tmp = tempfile.mkdtemp()
ls.TOKEN_FILE = Path(tmp) / "laya-token"
TOKEN = "0123456789abcdef" * 4

m = ls.Model("fake"); m.agent = FakeAgent()
srv = ls.ThreadingHTTPServer(("127.0.0.1", 0), ls.make_handler(m, 0))
port = srv.server_address[1]
srv.RequestHandlerClass = ls.make_handler(m, port)
threading.Thread(target=srv.serve_forever, daemon=True).start()

def call(path, body=None, origin=None, host=None, token=None):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=None if body is None else json.dumps(body).encode())
    if origin: req.add_header("Origin", origin)
    if token: req.add_header("X-Hub-Token", token)
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

# /workflow
wf = {"state": "google search 'a' then google search 'b'", "moves": ["search_frustration_escalator", "seq_a-com_b-com_c-org", "bogus id!"]}
s, r = call("/workflow", wf, ext)
check("workflow: extension origin works", s == 200 and r["ok"] is True)
check("workflow: reply shape", set(r) >= {"ok", "should_stage", "next_move", "ms"}
      and r["should_stage"]["choice"] in ("yes", "no", "unsure") and 0 <= r["should_stage"]["p"] <= 1
      and r["next_move"]["choice"] == "search_frustration_escalator" and r["next_move"]["p"] == 0.9
      and set(r["next_move"]["probs"]) == {"search_frustration_escalator", "seq_a-com_b-com_c-org", "none"})
check("workflow: yes at p 0.9", r["should_stage"] == {"choice": "yes", "p": 0.9, "route": "auto"})
check("workflow: seq_ criterion names the sites", seen["criteria"]["seq_a-com_b-com_c-org"].startswith(ls.SEQ_CRITERION)
      and "a.com then b.com then c.org" in seen["criteria"]["seq_a-com_b-com_c-org"])
check("workflow: unknown non-seq id dropped", "bogus id!" not in seen["criteria"])
call("/workflow", {"state": "x" * 10_000, "moves": []}, ext)
check("workflow: state capped at MAX_TEXT", len(seen["state"]) == ls.MAX_TEXT and list(seen["criteria"]) == ["none"])
check("workflow: no token file, no origin -> 403", call("/workflow", wf)[0] == 403)
check("workflow: no token file, any token -> 403", call("/workflow", wf, token="x")[0] == 403)
ls.TOKEN_FILE.write_text(TOKEN + "\n"); os.chmod(ls.TOKEN_FILE, 0o600)
s, r = call("/workflow", wf, token=TOKEN); check("workflow: right token works", s == 200 and r["ok"] is True)
check("workflow: wrong token -> 403", call("/workflow", wf, token=TOKEN[:-1] + "0")[0] == 403)
check("workflow: missing token, no origin -> 403", call("/workflow", wf)[0] == 403)
check("workflow: website origin -> 403", call("/workflow", wf, "https://evil.example")[0] == 403)
check("workflow: token with other Host -> 403", call("/workflow", wf, token=TOKEN, host=f"evil.example:{port}")[0] == 403)
check("workflow: extension origin with other Host -> 403", call("/workflow", wf, ext, host=f"evil.example:{port}")[0] == 403)
check("workflow: empty state -> 400", call("/workflow", {"state": "  ", "moves": []}, ext)[0] == 400)
check("workflow: moves not a list -> 400", call("/workflow", {"state": "x", "moves": "nav"}, ext)[0] == 400)
check("decide still refuses token without origin", call("/decide", {"text": "x"}, token=TOKEN)[0] == 403)
m.agent = UntrainedAgent()
s, r = call("/workflow", wf, ext); check("workflow: untrained engine -> graceful error", s == 503 and r == {"ok": False, "error": "workflow questions not trained"})
check("decide unaffected by untrained workflow", call("/decide", {"text": "x"}, ext)[0] == 200)
m.agent = None
check("workflow: not loaded gives 503", call("/workflow", wf, ext)[0] == 503)
check("not loaded gives 503", call("/decide", {"text": "x"}, ext)[0] == 503)

# ---- v0.4.1: compact array state, device choice, workflow fit, single-pass should_stage
m.agent = FakeAgent()
s, r = call("/workflow", {"state": ["google:q=a", "google:q=b"], "moves": ["search_frustration_escalator"]}, ext)
check("workflow: array state accepted", s == 200 and r["ok"] and seen["state"] == "google:q=a → now: google:q=b")
call("/workflow", {"state": [f"e{i}" for i in range(9)] + [7, None, {"x": 1}, "  "], "moves": []}, ext)
check("workflow: array keeps last 5 strings via to_text, newest 3 repeated", seen["state"] == "e5 → e6 → e7 → e8 → now: 7")
check("to_text: only the newest is prefixed now:", ls.workflow_state.to_text(["a", "b", "c"]) == "a → b → now: c")
check("state_text normalises canvas events", ls.state_text(["school.instructure.com/courses/123/assignments/9"]) == "now: canvas/courses/:id/assignments/:id")

# ---- /workflow LRU: last 3 events (plus the move ids) -> answer; cleared when a fit is (re)loaded
mv = ["search_frustration_escalator"]
n0 = seen["n"]
s1, r1 = call("/workflow", {"state": ["x0", "a", "b", "c"], "moves": mv}, ext)
s2, r2 = call("/workflow", {"state": ["y9", "y8", "a", "b", "c"], "moves": mv}, ext)  # same last 3
check("cache: same last 3 events answered once", seen["n"] == n0 + 1 and r2.get("cached") is True and r2["next_move"] == r1["next_move"])
call("/workflow", {"state": ["a", "b", "d"], "moves": mv}, ext)
check("cache: different tail asks again", seen["n"] == n0 + 2)
call("/workflow", {"state": ["a", "b", "c"], "moves": []}, ext)
check("cache: different moves ask again", seen["n"] == n0 + 3)
c = ls.WorkflowCache(3)
for k in "abcd": c.put(k, {"v": k})
c.get("b"); c.put("e", {"v": "e"})
check("cache: LRU evicts the least recently used, max size", c.get("a") is None and c.get("c") is None and c.get("b") and c.get("d") and c.get("e") and len(c.d) == 3)
check("cache: key is last 3 joined with |", ls.WorkflowCache.key(["1", "2", "3", "4"], ["m"]) == "2|3|4#m" and ls.WorkflowCache.key("text", []) is None and ls.CACHE_MAX == 200)
m.cache.clear()
check("cache: clear empties", m.cache.get("a|b|c#search_frustration_escalator") is None)
m.load_workflow(FakeAgent(), "/nonexistent-fit")
check("cache: reloading the fit clears it", len(m.cache.d) == 0)
check("workflow: state object -> 400", call("/workflow", {"state": {"a": 1}, "moves": []}, ext)[0] == 400)
check("workflow: empty array -> 400", call("/workflow", {"state": [], "moves": []}, ext)[0] == 400)
check("workflow: string state still works", call("/workflow", {"state": "old text", "moves": []}, ext)[0] == 200 and seen["state"] == "old text")

import types
calls = {}
fake_torch = types.ModuleType("torch")
fake_torch.cuda = types.SimpleNamespace(is_available=lambda: True)
fake_torch.set_num_threads = lambda n: calls.setdefault("threads", n)
real_torch = sys.modules.get("torch"); sys.modules["torch"] = fake_torch
check("device: auto picks cuda when torch sees a GPU", ls.resolve_device("auto") == "cuda")
check("device: cpu forced even with a GPU", ls.resolve_device("cpu") == "cpu")
fake_torch.cuda = types.SimpleNamespace(is_available=lambda: False)
check("device: cuda asked, none there -> cpu", ls.resolve_device("cuda") == "cpu")
check("device: auto without GPU -> cpu", ls.resolve_device(None) == "cpu")
fake_torch.cuda = types.SimpleNamespace(is_available=lambda: True)

ls.DATA = Path(tmp) / "data"; ls.LABEL_FILES = []
ls.WORKFLOW_FIT_DIR = ls.DATA / "workflow-fit"
ls.WORKFLOW_ROW_FILES = [ls.DATA / "rows.jsonl"]
CANON = list(ls.fit_questions("single")[ls.FIT_NEXT]["criteria"])

class FitAgent:
    """Stands in for VegaAgent: per-question heads in vega.heads, one calibration slot."""
    def __init__(self, device=None, **kw):
        self.device = device; self.vega = types.SimpleNamespace(heads={"destination": ("dest-head", 0.9)})
        self.calibration = "dest-cal"; self._novelty = None; self.next_probs = None; self.cal_seen = []
    def fit(self, rows, questions=None, folds=5, calibrate=True):
        calls["fit"] = {"n": len(rows), "qs": sorted(questions), "folds": folds, "rows": rows}
        for q in questions: self.vega.heads[q] = ("head-" + q, 0.8)
        if calibrate: self.calibration = "wf-cal"
        return {"heads": {q: {"fitted": True, "examples": len(rows), "cv_accuracy": 0.8} for q in questions}}
    def save_calibration(self, path):
        calls["saved_heads"] = sorted(self.vega.heads); calls["saved_cal"] = self.calibration
        Path(path, "heads.npz").write_text(json.dumps(sorted(self.vega.heads)))
        if self.calibration: Path(path, "calibration.json").write_text(json.dumps(self.calibration))
        Path(path, "manifest.json").write_text("{}")
    def load_calibration(self, path):
        names = json.loads(Path(path, "heads.npz").read_text())
        for q in names: self.vega.heads[q] = ("head-" + q, 0.8)
        cp = Path(path, "calibration.json")
        self.calibration = json.loads(cp.read_text()) if cp.exists() else None
        return {"heads": names}
    def predict(self, state, questions):
        if "destination" in questions:
            self.cal_seen.append(("decide", self.calibration))
            return {"answers": {"destination": {"probabilities": {"google": 0.3, "ai": 0.7}}}}
        self.cal_seen.append(("workflow", self.calibration)); calls["wf_qs"] = sorted(questions); calls["wf_state"] = state
        probs = self.next_probs or {k: 1 / len(CANON) for k in CANON}
        ans = {ls.FIT_NEXT: {"type": "choice", "probabilities": probs, "route": "auto"}}
        if ls.FIT_STAGE in questions: ans[ls.FIT_STAGE] = {"type": "noul", "noul": 0.2, "route": "review"}
        return {"answers": ans}

fake_laya = types.ModuleType("laya"); fake_laya.Agent = FitAgent
real_laya = sys.modules.get("laya"); sys.modules["laya"] = fake_laya
calls.clear()
lm = ls.Model("vega", 4, "cpu"); lm.load()
check("device: Model passes cpu to laya.Agent and sets threads", lm.error is None and lm.agent.device == "cpu" and lm.device == "cpu" and calls.get("threads") == 4)
lm2 = ls.Model("vega", 4, "auto"); lm2.load()
check("device: auto -> cuda passed to laya.Agent", lm2.agent.device == "cuda")
check("no workflow fit -> zero-shot", lm.wf is None)

ROWS = [{"state": ["google:q=a", "google:q=b"], "next_move": "search_frustration_escalator", "should_stage": True, "source": "seed"},
        {"state": ["weather.com/"], "next_move": "none", "should_stage": False, "source": "seed"},
        {"state": ["a.com/", "b.com/", "c.com/"], "next_move": "seq_a-com_b-com_c-com", "should_stage": True, "source": "auto_pos"},
        {"state": ["school.instructure.com/courses/1"], "next_move": "canvas_study_bridge", "should_stage": False, "source": "auto_neg"},
        {"state": ["x"], "next_move": "bogus", "should_stage": True}, {"state": [], "next_move": "none", "should_stage": False}]
ls.DATA.mkdir(parents=True, exist_ok=True)
ls.WORKFLOW_ROW_FILES[0].write_text("".join(json.dumps(r) + "\n" for r in ROWS))
ag = lm.agent
ag.calibration = "dest-cal"; ag.vega.heads = {"destination": ("dest-head", 0.9)}  # as after loading vega-fit
res = ls.train_workflow(ROWS, device="cpu", agent=ag)
d = ls.WORKFLOW_FIT_DIR
check("train_workflow: returns n/seconds/out_dir", res["n"] == 6 and res["n_unique"] == 4 and res["out_dir"] == str(d) and isinstance(res["seconds"], float))
check("train_workflow: writes fit dir + stamp", all((d / f).exists() for f in ("heads.npz", "calibration.json", "manifest.json", "labels.sha256", "fit_info.json"))
      and (d / "labels.sha256").read_text() == ls.workflow_fit_hash(ROWS, "single"))
check("train_workflow: fit dir and files private", (d.stat().st_mode & 0o777) == 0o700 and ((d / "labels.sha256").stat().st_mode & 0o777) == 0o600)
check("train_workflow: single layout gold (seq -> repeat_sequence, unstaged -> none)",
      calls["fit"]["qs"] == [ls.FIT_NEXT] and [r["gold"][ls.FIT_NEXT] for r in calls["fit"]["rows"]] == ["search_frustration_escalator", "none", ls.SEQ_LABEL, "none"] + ["search_frustration_escalator", "none"]
      and calls["fit"]["rows"][0]["state"] == "google:q=a → now: google:q=b")
check("train_workflow: saves only workflow heads + workflow calibration", calls["saved_heads"] == [ls.FIT_NEXT] and calls["saved_cal"] == "wf-cal")
check("train_workflow: destination head and calibration left as they were", ag.calibration == "dest-cal" and ag.vega.heads["destination"] == ("dest-head", 0.9))
check("hash: row order does not matter, questions do", ls.workflow_fit_hash(ROWS[::-1]) == ls.workflow_fit_hash(ROWS) and ls.workflow_fit_hash(ROWS, "two") != ls.workflow_fit_hash(ROWS))

wf = lm.load_workflow(ag)
check("load_workflow: fresh fit loaded, destination calibration kept", wf == {"layout": "single", "n": 6, "stale": False, "t": wf["t"]} and lm.wf_cal == "wf-cal" and ag.calibration == "dest-cal")
srv.RequestHandlerClass = ls.make_handler(lm, port)
h = call("/health")[1]
check("health reports device and workflow fit", h["device"] == "cpu" and h["workflow"]["fitted"] is True and h["workflow"]["layout"] == "single")

ag.next_probs = {k: 0.0 for k in CANON}; ag.next_probs.update({"canvas_study_bridge": 0.6, "creative_asset_router": 0.25, "none": 0.1, ls.SEQ_LABEL: 0.05})
ag.cal_seen.clear()
s, r = call("/workflow", {"state": ["school.instructure.com/courses/1/assignments/2"],
                          "moves": ["canvas_study_bridge", "seq_x-com_y-com_z-com", "seq_school-instructure-com_a-com_b-com"]}, ext)
check("fitted: asks the fixed question once (single pass)", s == 200 and calls["wf_qs"] == [ls.FIT_NEXT])
check("fitted: workflow calibration swapped in only for the call", ag.cal_seen == [("workflow", "wf-cal")] and ag.calibration == "dest-cal")
pr = r["next_move"]["probs"]
check("fitted: probs narrowed to enabled moves + none, renormalised",
      set(pr) == {"canvas_study_bridge", "seq_x-com_y-com_z-com", "seq_school-instructure-com_a-com_b-com", "none"}
      and abs(sum(pr.values()) - 1) < 1e-3 and abs(pr["canvas_study_bridge"] - 0.6 / 0.75) < 1e-3)
check("fitted: repeat_sequence goes to the seq move matching the state", pr["seq_school-instructure-com_a-com_b-com"] > 0 and pr["seq_x-com_y-com_z-com"] == 0)
check("single-pass: should_stage derived as 1 - p(none)",
      r["next_move"]["choice"] == "canvas_study_bridge" and r["should_stage"]["choice"] == "yes"
      and abs(r["should_stage"]["p"] - round(1 - pr["none"], 4)) < 1e-4 and r["should_stage"]["route"] == "auto")
ag.next_probs = {k: 0.0 for k in CANON}; ag.next_probs.update({"none": 0.7, "creative_asset_router": 0.3})
s, r = call("/workflow", {"state": ["weather.com/"], "moves": ["creative_asset_router"]}, ext)
check("single-pass: none wins -> should_stage no", r["next_move"]["choice"] == "none" and r["should_stage"] == {"choice": "no", "p": 0.7, "route": "auto"})
ag.next_probs = {k: 0.0 for k in CANON}; ag.next_probs.update({"none": 0.5, "creative_asset_router": 0.5})
s, r = call("/workflow", {"state": ["x.com/"], "moves": ["creative_asset_router"]}, ext)
check("single-pass: a move beating none (50/50 tie) -> yes", r["should_stage"]["choice"] == "yes")
ag.next_probs.update({"none": 0.55, "creative_asset_router": 0.45})
s, r = call("/workflow", {"state": ["x.com/", "y.com/"], "moves": ["creative_asset_router"]}, ext)
check("single-pass: 45/55 -> unsure", r["should_stage"]["choice"] == "unsure")
s, r = call("/workflow", {"state": ["x.com/"], "moves": []}, ext)
check("fitted: no moves enabled -> none only", r["next_move"]["probs"] == {"none": 1.0} and r["should_stage"]["choice"] == "no")
s, r = call("/decide", {"text": "x"}, ext)
check("decide after workflow calls uses destination calibration", s == 200 and ag.cal_seen[-1] == ("decide", "dest-cal"))

ls.WORKFLOW_ROW_FILES[0].write_text(json.dumps(ROWS[0]) + "\n")
check("load_workflow: rows changed -> loaded but stale", ls.Model("vega").load_workflow(ag)["stale"] is True)
info = json.loads((d / "fit_info.json").read_text()); info["questions_sha256"] = "0" * 64
(d / "fit_info.json").write_text(json.dumps(info))
check("load_workflow: other questions -> ignored", ls.Model("vega").load_workflow(ag) is None)

res2 = ls.train_workflow(ROWS, device="cpu", agent=FitAgent(), layout="two", out_dir=Path(tmp) / "fit-two")
check("train_workflow: two-question layout gold", res2["layout"] == "two" and calls["fit"]["qs"] == sorted([ls.FIT_NEXT, ls.FIT_STAGE])
      and [r["gold"][ls.FIT_STAGE] for r in calls["fit"]["rows"]] == [True, False, True, False, True, False])
lm.load_workflow(ag, Path(tmp) / "fit-two")
ag.next_probs = {k: 0.0 for k in CANON}; ag.next_probs.update({"canvas_study_bridge": 0.9, "none": 0.1})
s, r = call("/workflow", {"state": ["a.com/"], "moves": ["canvas_study_bridge"]}, ext)
check("two-question layout: should_stage from its own head", calls["wf_qs"] == sorted([ls.FIT_NEXT, ls.FIT_STAGE])
      and r["should_stage"] == {"choice": "no", "p": 0.8, "route": "review"} and r["next_move"]["choice"] == "canvas_study_bridge")
dd = Path(tmp) / "dedupe"; dd.mkdir()
(dd / "workflow_training_seed.jsonl").write_text(json.dumps({"state": ["p", "a", "b", "c", "d", "e"], "next_move": "none", "should_stage": False}) + "\n")
(dd / "workflow_mined.jsonl").write_text(json.dumps({"state": ["a", "b", "c", "d", "e"], "next_move": "canvas_study_bridge", "should_stage": True, "source": "auto_pos"}) + "\n"
                                         + json.dumps({"state": ["z"], "next_move": "bogus", "should_stage": True}) + "\n")
got = ls.read_rows([dd / "workflow_training_seed.jsonl", dd / "workflow_mined.jsonl"])
check("read_rows: one row per last-5 state, seed beats auto, bad ids dropped", got == [{"state": ["a", "b", "c", "d", "e"], "next_move": "none", "should_stage": False, "source": "seed"}])
# retired calc move, de-duplication, honest CV
_row = {"state": ["google:q=350 f to c"], "next_move": "inline_unit_camera_calc", "should_stage": True}
check("clean_rows: retired calc move -> none, not staged", [(r["next_move"], r["should_stage"]) for r in ls.clean_rows([_row])] == [("none", False)])
_d = ls.dedupe_rows([{**_row, "source": "auto_neg"}, {**_row, "next_move": "none", "should_stage": False, "source": "human"}])
check("dedupe_rows: one row per state, best source", len(_d) == 1 and _d[0]["source"] == "human")
_pool = [{"state": [f"a{i}"], "next_move": "none", "should_stage": False, "source": "seed"} for i in range(20)]
_fs = ls._folds(_pool, 5)
check("CV folds: validation states never in training", len(_fs) == 5 and all(not ({tuple(r["state"]) for r in v} & {tuple(r["state"]) for r in t}) for t, v in _fs))
check("oversample: 2x human/seed only", len(ls.oversample([{"source": "seed"}, {"source": "auto_pos"}])) == 3)
_cvres = ls.train_workflow(ROWS, device="cpu", agent=FitAgent(), out_dir=Path(tmp) / "fit-cv")["cv"]
check("train_workflow: reports CV over unique states", _cvres["n"] == 4 and 0 <= _cvres["accuracy"] <= 1)
# long-state trimming: event/query cap, oldest events dropped (newest 2 kept), token clip as the last resort
import workflow_state as _ws, laya_ov as _ov
_ev = [f"school.example/courses/{i}/pages/{'x' * 100}" for i in range(6)]
_txt = ls.state_text(_ev)
check("state_text: each event capped at 80 chars, 'now:' kept on the newest", all(len(p) <= 80 + 5 for p in _txt.split(" \u2192 ")) and _txt.split(" \u2192 ")[-1].startswith("now: "))
check("state_text: canvas ids normalized before the cap", ls.state_text(["school.instructure.com/courses/123/modules"]) == "now: canvas/courses/:id/modules")
_count = lambda t: len([w for w in t.split() if w != "\u2192"])   # one 'token' per word
_five = ["a b", "c d", "e f", "g h", "i j"]
_kept = _ws.trim_events(_five, _count, 7)
check("trim_events: drops the oldest until it fits", _kept == ["e f", "g h", "i j"] and _count(_ws.to_text(_kept)) <= 7 + 1)
check("trim_events: keeps the newest 2 even when still over", _ws.trim_events(_five, _count, 1) == ["g h", "i j"])
check("trim_events: under budget changes nothing", _ws.trim_events(_five, _count, 99) == _five)
_fit = ls.fit_text(ls.state_text(_five), _count, 7)
check("fit_text: oldest dropped, 'now:' on the newest", _fit.split(" \u2192 ")[-1] == "now: i j" and "a b" not in _fit and "e f" in _fit)
_it = {"ids": list(range(30)), "spans": {"state": (2, 20), "question": (20, 24), "options": [(24, 27), (27, 29)]}}
_c = _ov.clip_item(_it, 24)
check("clip_item: oldest state tokens cut to the static length, spans shifted",
      len(_c["ids"]) == 24 and _c["spans"]["state"] == (2, 14) and _c["spans"]["question"] == (14, 18)
      and _c["spans"]["options"] == [(18, 21), (21, 23)] and list(_c["ids"])[-3:] == [27, 28, 29])
check("clip_item: a prompt that fits is returned untouched", _ov.clip_item(_it, 30) is _it)
_c2 = _ov.clip_item(_it, 12)
check("clip_item: 2 events too long still clips tokens and never exceeds max_len", len(_c2["ids"]) <= 12 and _c2["spans"]["state"][1] - _c2["spans"]["state"][0] >= 1)
# token auto-creation
_tf = ls.TOKEN_FILE; ls.TOKEN_FILE = Path(tmp) / "newcfg" / "laya-token"
ls.ensure_token(); _t1 = ls.read_token(); ls.ensure_token()
check("ensure_token: creates dir 700, file 600, random token, keeps it", _t1 and len(_t1) >= 32 and ls.read_token() == _t1
      and (ls.TOKEN_FILE.parent.stat().st_mode & 0o777) == 0o700 and (ls.TOKEN_FILE.stat().st_mode & 0o777) == 0o600)
ls.TOKEN_FILE = _tf
for name, mod in (("torch", real_torch), ("laya", real_laya)):
    if mod is None: sys.modules.pop(name, None)
    else: sys.modules[name] = mod
print(f"{fail} failed" if fail else "all passed"); sys.exit(1 if fail else 0)
