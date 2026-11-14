# Run: python3 -I tests/train_workflow_cli_test.py   (made-up places.sqlite in a temp folder; laya is never asked)
import json, os, shutil, sqlite3, stat, subprocess, sys, tempfile, time, types
from pathlib import Path
os.environ["LAYA_RELOAD"] = "0"; os.environ["LAYA_OV_AUTOEXPORT"] = "0"   # tests never restart the real service or export
TMP = Path(tempfile.mkdtemp())
PROFILE, SCRATCH, OUT, LAB = TMP / "profile", TMP / "scratch", TMP / "out", TMP / "lab"
for d in (PROFILE, SCRATCH):
    d.mkdir()
HELPER = Path(__file__).resolve().parent.parent / "helper"
CLI = HELPER / "train_workflow_cli.py"
ENV = {**os.environ, "TMPDIR": str(SCRATCH), "XDG_DATA_HOME": str(TMP / "data"), "XDG_CONFIG_HOME": str(TMP / "cfg")}

db = sqlite3.connect(PROFILE / "places.sqlite")
db.executescript("""
CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT, title TEXT);
CREATE TABLE moz_historyvisits (id INTEGER PRIMARY KEY, place_id INTEGER, visit_date INTEGER, visit_type INTEGER);
""")
ids = {}

def visit(t, url, title=None, vtype=1):
    if url not in ids:
        ids[url] = db.execute("INSERT INTO moz_places (url, title) VALUES (?, ?)", (url, title)).lastrowid
    db.execute("INSERT INTO moz_historyvisits (place_id, visit_date, visit_type) VALUES (?, ?, ?)",
               (ids[url], int(t * 1e6), vtype))

G = "https://www.google.com/search?q="
P = "https://www.pinterest.com/search/pins/?q="
t = time.time() - 10 * 86400
HOUR = 3600  # every scene is its own session
# 1 frustration pair (Jaccard 6/7) -> auto_pos
visit(t, "https://news.example.org/today")
visit(t + 10, G + "how+to+fix+printer+offline+error"); visit(t + 30, G + "how+to+fix+printer+offline+error+windows")
# 2 near miss pair (Jaccard 3/7 ~ 0.43) -> edge
t += HOUR
visit(t, G + "best+budget+camera+for+video"); visit(t + 25, G + "budget+camera+for+beginners+lens")
# 3 two pinterest searches -> edge harvest near miss
t += HOUR
visit(t, P + "retro+poster+layout"); visit(t + 60, P + "retro+poster+fonts")
# 4 three pinterest searches -> auto_pos creative
t += HOUR
visit(t, P + "moody+portrait+lighting"); visit(t + 50, P + "moody+portrait+studio"); visit(t + 100, P + "moody+portrait+pose")
# 5 canvas assignment, with a Microsoft sign-in hop on the way -> auto_pos canvas
t += HOUR
visit(t, "https://school.instructure.com/courses/111")
visit(t + 5, "https://login.microsoftonline.com/common/oauth2/authorize")
visit(t + 10, "https://school.instructure.com/courses/111/assignments/9")
# 6 casual browsing, three sessions -> auto_neg
for k in range(3):
    t += HOUR
    for j, u in enumerate(["news.example.org/a", "wiki.example.net/b", "shop.example.com/c", "video.example.com/watch",
                           "forum.example.org/t", "recipes.example.com/d", "maps.example.net/e"]):
        visit(t + j * 40, f"https://{u}{k}")
db.commit(); db.close()

def run(*args, inp=None, data=OUT):
    return subprocess.run([sys.executable, "-I", str(CLI), "--out-dir", str(data), *args],
                          env=ENV, capture_output=True, text=True, input=inp)

def rows(p):
    return [json.loads(l) for l in Path(p).read_text().splitlines() if l.strip()]

mode = lambda p: stat.S_IMODE(os.stat(p).st_mode)
checks = []
r = run("--mine", "--profile", str(PROFILE), "--seed-rng", "7")
mined, edges = rows(OUT / "workflow_mined.jsonl"), rows(OUT / "workflow_edge_cases.jsonl")
pos = {x["next_move"]: x for x in mined if x["source"] == "auto_pos"}
neg = [x for x in mined if x["source"] == "auto_neg"]
reasons = sorted(x["reason"] for x in edges)
everything = (OUT / "workflow_mined.jsonl").read_text() + (OUT / "workflow_edge_cases.jsonl").read_text()
checks += [
    ("mine runs", r.returncode == 0, r.stderr[-400:]),
    ("frustration auto_pos", pos.get("search_frustration_escalator", {}).get("state") ==
     ["news.example.org/today", "google:q=how to fix printer offline error", "google:q=how to fix printer offline error windows"], pos),
    ("creative auto_pos", pos.get("creative_asset_router", {}).get("state") ==
     ["pinterest:q=moody portrait lighting", "pinterest:q=moody portrait studio", "pinterest:q=moody portrait pose"], pos),
    ("canvas auto_pos, sso gone", pos.get("canvas_study_bridge", {}).get("state") ==
     ["canvas/courses/:id", "canvas/courses/:id/assignments/:id"], pos),
    ("only those positives", sorted(pos) == ["canvas_study_bridge", "creative_asset_router", "search_frustration_escalator"]
     and len(mined) - len(neg) == 3, [x["state"] for x in mined if x["source"] == "auto_pos"]),
    ("positive shape", all(x["should_stage"] is True for x in pos.values()), pos),
    ("negatives ~1.5x", len(neg) in (4, 5) and all(x["next_move"] == "none" and x["should_stage"] is False
                                                  and 4 <= len(x["state"]) <= 5 for x in neg), neg),
    ("negatives are casual", all(all(s.split(".")[0] in ("news", "wiki", "shop", "video", "forum", "recipes", "maps")
                                     for s in x["state"]) for x in neg), neg),
    ("no duplicate states", len({tuple(x["state"]) for x in mined + edges}) == len(mined) + len(edges), ""),
    ("edge reasons", reasons == ["frustration_near_miss", "harvest_near_miss"], edges),
    ("edge near miss state", any(x["state"] == ["google:q=best budget camera for video", "google:q=budget camera for beginners lens"]
                                 for x in edges), edges),
    ("edge harvest state", any(x["state"] == ["pinterest:q=retro poster layout", "pinterest:q=retro poster fonts"] for x in edges), edges),
    ("edges unlabelled", all("next_move" not in x for x in edges), edges),
    ("sso never in a state", "microsoftonline" not in everything and "oauth" not in everything, ""),
    ("print has no queries", "printer" not in r.stdout and "pinterest:q" not in r.stdout and "auto_neg" in r.stdout, r.stdout),
    ("files 600", mode(OUT / "workflow_mined.jsonl") == 0o600 and mode(OUT / "workflow_edge_cases.jsonl") == 0o600, ""),
    ("temp copy removed", list(SCRATCH.iterdir()) == [], list(SCRATCH.iterdir())),
    ("nothing in default data dir", not (TMP / "data").exists(), ""),
]
r2 = run("--mine", "--profile", str(PROFILE), "--seed-rng", "7")
checks.append(("seeded = repeatable", r2.returncode == 0 and rows(OUT / "workflow_mined.jsonl") == mined, ""))

# --interactive with piped keys: 2 = frustration, n = none, s = skip, q = save (no train)
LAB.mkdir()
edge_rows = [{"state": [f"site{i}.example.com/p", f"google:q=thing {i}"], "reason": "frustration_near_miss"} for i in range(4)]
(LAB / "workflow_edge_cases.jsonl").write_text("".join(json.dumps(x) + "\n" for x in edge_rows))
r = run("--interactive", "--no-train", inp="2ns q\n", data=LAB)
labels = rows(LAB / "workflow_labels.jsonl")
checks += [
    ("interactive runs", r.returncode == 0, r.stderr[-400:] + r.stdout[-400:]),
    ("labels", [(x["state"], x["next_move"], x["should_stage"], x["source"]) for x in labels] ==
     [(edge_rows[0]["state"], "search_frustration_escalator", True, "human"), (edge_rows[1]["state"], "none", False, "human")], labels),
    ("progress shown", all(f"[{i}/4]" in r.stdout for i in range(1, 5)) and "skipped" in r.stdout, r.stdout),
    ("events listed", "1. site0.example.com/p" in r.stdout and "frustration_near_miss" in r.stdout, r.stdout),
    ("labels 600", mode(LAB / "workflow_labels.jsonl") == 0o600, oct(mode(LAB / "workflow_labels.jsonl"))),
]
r = run("--interactive", "--no-train", inp="4\n", data=LAB)  # the skipped one comes back first
labels = rows(LAB / "workflow_labels.jsonl")
checks += [
    ("labelled ones not shown again", r.returncode == 0 and "site0" not in r.stdout and "3/4" in r.stdout, r.stdout),
    ("skipped one labelled now", labels[-1]["state"] == edge_rows[2]["state"] and labels[-1]["next_move"] == "creative_asset_router"
     and len(labels) == 3, labels),
]

# --train: merge with priorities, call laya_server.train_workflow (a fake one here)
same = ["a.example.com/x", "google:q=same"]
(LAB / "workflow_training_seed.jsonl").write_text(
    json.dumps({"state": same, "next_move": "none", "should_stage": False, "source": "seed"}) + "\n" +
    json.dumps({"state": edge_rows[0]["state"], "next_move": "none", "should_stage": False, "source": "seed"}) + "\n")
(LAB / "workflow_mined.jsonl").write_text(
    json.dumps({"state": same, "next_move": "nav_shortcut_interceptor", "should_stage": True, "source": "auto_pos"}) + "\n" +
    json.dumps({"state": ["b.example.com/"] * 4, "next_move": "none", "should_stage": False, "source": "auto_neg"}) + "\n")
sys.path.insert(0, str(HELPER))
os.environ["XDG_DATA_HOME"] = str(TMP / "data")
import train_workflow_cli as cli
got = {}
sys.modules["laya_server"] = types.SimpleNamespace(train_workflow=lambda rows, device: got.update(rows=rows, device=device) or {"ok": True})
code = cli.main(["--train", "--device", "cpu", "--out-dir", str(LAB)])
by = {tuple(x["state"]): x for x in got.get("rows", [])}
checks += [
    ("train calls laya", code == 0 and got.get("device") == "cpu" and len(by) == 5, got),
    ("seed beats auto", by.get(tuple(same), {}).get("source") == "seed", by.get(tuple(same))),
    ("human beats seed", by.get(tuple(edge_rows[0]["state"]), {}).get("next_move") == "search_frustration_escalator", ""),
]
sys.modules["laya_server"] = types.SimpleNamespace()
checks.append(("no train_workflow -> 2", cli.main(["--train", "--out-dir", str(LAB)]) == 2, ""))

r = run("--stats", data=LAB)
checks.append(("stats", r.returncode == 0 and "workflow_labels.jsonl: 3 rows" in r.stdout and "labelled: 3" in r.stdout, r.stdout))
checks.append(("calc detector", cli.is_calc("157919mb to gb") and cli.is_calc("8tb at 400mbps") and cli.is_calc("27000 mah")
               and cli.is_calc("how long can an xt4 record on 512gb") and not cli.is_calc("best camera 2024"), ""))

# --import-sheet parser: filled brackets only, valid codes, ids deduped, rows mapped to real move names
S1, S2, S3 = ["google:q=yt", "youtube.com/"], ["pinterest:q=a", "pexels:q=b"], ["a.com/", "b.com/<x>-->"]
def _line(code, sec, st):
    return "- [%s] `%s` <!--%s-->  guess **none** @ 0.5\n    1. `%s`" % (code, cli.item_id(sec, st), json.dumps(st).replace(">", "\\u003e").replace("<", "\\u003c"), st[0])
sheet = "\n".join([_line("1", "A", S1), _line(" ", "B", S2), _line("N", "C", S3), _line("x", "A", ["z.com/", "y.com/"]),
                    _line("4", "A", S1), "## header", "- [ ] not an item"])
ent = cli.parse_sheet(sheet)
rws = cli.import_rows(ent, [])
checks += [
    ("sheet: blanks and bad codes skipped, id deduped", [e[1] for e in ent] == ["1", "n"], ent),
    ("sheet: awkward state survives", ent[1][2] == S3, ent),
    ("sheet: code 1 -> nav, staged", rws[0]["next_move"] == "nav_shortcut_interceptor" and rws[0]["should_stage"] is True
        and rws[0]["source"] == "human", rws),
    ("sheet: n -> none, not staged", rws[1]["next_move"] == "none" and rws[1]["should_stage"] is False, rws),
    ("sheet: already-labelled state skipped", len(cli.import_rows(ent, [tuple(S1)])) == 1, ""),
    ("sheet: codes map 1-4", [cli.SHEET_CODES[c] for c in "1234"] == [
        "nav_shortcut_interceptor", "search_frustration_escalator", "canvas_study_bridge", "creative_asset_router"], ""),
    ("gather: calc rows become none", (LAB / "c").mkdir() is None and (LAB / "c" / "workflow_mined.jsonl").write_text(json.dumps(
        {"state": ["google:q=350 f to c"], "next_move": "inline_unit_camera_calc", "should_stage": True, "source": "auto_pos"}) + "\n") > 0
        and [(r["next_move"], r["should_stage"]) for r in cli.gather(LAB / "c")] == [("none", False)], ""),
]

# ---- v0.4.2 rules: creative Google queries, canvas only on the newest event, nav on the last 3 events
def _ev(t, c, host=None):
    e = cli.enrich({"url": "https://" + c if not c.startswith("http") else c, "host": host or c.split("/")[0], "path": "/" + c.split("/", 1)[-1] if "/" in c else "/", "t": t, "q": None})
    return e
def _g(t, q):
    from urllib.parse import quote_plus
    u = "https://www.google.com/search?q=" + quote_plus(q)
    return cli.enrich({"url": u, "host": "google.com", "path": "/search", "t": t, "q": q})
long_q = "stock photo of a vintage typewriter on a wooden desk with warm light and soft shadows please " * 1
sess_a = [_g(0, "retro poster layout free image"), _g(20, "retro poster layout free image download")]
sess_b = [_ev(0, "shutterstock.com/search/retro-poster"), _g(60, "retro poster layout ideas"), _g(80, "retro poster layout ideas more")]
sess_c = [_g(0, "printer offline"), _g(20, "printer offline error")]
sess_d = [_g(0, "a " * 7 + "stock image of cats and also dogs together outside"), _g(10, "b " * 7 + "stock image of cats and also dogs together outside")]
sess_e = [_ev(0, "shutterstock.com/search/retro-poster"), _g(200, "retro poster layout ideas"), _g(220, "retro poster layout ideas more")]
kinds = lambda sess: [(m, k) for _i, m, k in cli.scan(sess)]
CAN = "canvas/courses/:id/"
checks += [
    ("new creative engines", all(x in cli.CREATIVE for x in ("dreamstime", "shutterstock", "vecteezy", "freerangestock"))
        and cli.ws.compact_url("https://www.shutterstock.com/search/retro-poster") == "shutterstock:q=retro poster"
        and cli.ws.compact_url("https://www.dreamstime.com/search.php?srh_field=old+map") == "dreamstime:q=old map", ""),
    ("python compact_url matches the shared vectors", all(cli.ws.compact_url(v["url"]) == v["out"] for v in json.loads(
        (HELPER.parent / "tests" / "workflow_state_vectors.json").read_text()) if "url" in v), ""),
    ("free image query -> creative, not frustration", ("creative_asset_router", "fire") in kinds(sess_a)
        and ("search_frustration_escalator", "fire") not in kinds(sess_a), kinds(sess_a)),
    ("query within 120 s of a creative visit -> creative", ("creative_asset_router", "fire") in kinds(sess_b)
        and ("search_frustration_escalator", "fire") not in kinds(sess_b), kinds(sess_b)),
    ("120 s passed -> frustration again", ("search_frustration_escalator", "fire") in kinds(sess_e), kinds(sess_e)),
    ("plain pair stays frustration", ("search_frustration_escalator", "fire") in kinds(sess_c), kinds(sess_c)),
    ("long (>12 words) creative query -> creative", ("creative_asset_router", "fire") in kinds(sess_d)
        and ("search_frustration_escalator", "fire") not in kinds(sess_d), kinds(sess_d)),
    ("canvas: newest on assignment fires", cli.canvas_state(["x.com/", CAN + "assignments/5"]) and cli.canvas_state([CAN + "quizzes/7"]), ""),
    ("canvas: back on /modules does not", not cli.canvas_state([CAN + "assignments/5", CAN + "modules"])
        and cli.rule_label([CAN + "assignments/5", CAN + "modules"]) is None, ""),
    ("nav: diluted by earlier events still fires", cli.nav_state(["amazon.com/dp/x", "google:q=calendar", "calendar.google.com/calendar/u/0/r"])
        and cli.nav_state(["amazon.com/dp/x", "ebay.com/itm/1", "google:q=calendar", "calendar.google.com/"])
        and cli.rule_label(["amazon.com/dp/x", "google:q=calendar", "calendar.google.com/"]) == "nav_shortcut_interceptor", ""),
    ("nav: a page between, or a long query, does not", not cli.nav_state(["google:q=calendar", "amazon.com/", "calendar.google.com/"])
        and not cli.nav_state(["google:q=how do i add an event to my calendar today", "calendar.google.com/"]), ""),
    ("nav_landing looks only at the last 3 events", not cli.nav_landing(
        [_g(0, "calendar"), _g(5, "weather"), _g(8, "news"), _ev(10, "calendar.google.com/calendar")], 3), ""),
    ("canvas normalised: hosts and ids", cli.ws.compact_url("https://school.instructure.com/courses/123/modules/items/7") == "canvas/courses/:id/modules/items/:id"
        and cli.ws.normalize_state(["school.instructure.com/courses/5/assignments/9", "google:q=a", "x.com/courses/5"])
        == ["canvas/courses/:id/assignments/:id", "google:q=a", "x.com/courses/5"]
        and cli.canvas_state(["canvas/courses/:id/quizzes/:id"]), ""),
    ("old human label re-keyed on load", (LAB / "n").mkdir() is None and (LAB / "n" / "workflow_labels.jsonl").write_text(json.dumps(
        {"state": ["school.instructure.com/courses/1/quizzes/2", "school.instructure.com/courses/1/modules"], "next_move": "none", "should_stage": False, "source": "human"}) + "\n") > 0
        and (LAB / "n" / "workflow_mined.jsonl").write_text(json.dumps(
        {"state": ["x.instructure.com/courses/7/quizzes/8", "x.instructure.com/courses/7/modules"], "next_move": "canvas_study_bridge", "should_stage": True, "source": "auto_pos"}) + "\n") > 0
        and [(r["state"], r["next_move"], r["source"]) for r in cli.gather(LAB / "n")] == [(["canvas/courses/:id/quizzes/:id", "canvas/courses/:id/modules"], "none", "human")], ""),
    ("--cv and --no-cv parse; both is an error", run("--train", "--cv", "--no-cv", data=LAB / "none").returncode == 2, ""),
]
_kw = {}
sys.modules["laya_server"] = types.SimpleNamespace(train_workflow=lambda rows, device, **k: _kw.update(k) or {"ok": True})
cli.main(["--train", "--out-dir", str(LAB), "--no-cv"]); a1 = dict(_kw); _kw.clear()
cli.main(["--train", "--out-dir", str(LAB), "--cv"]); a2 = dict(_kw); _kw.clear()
cli.main(["--train", "--out-dir", str(LAB)]); a3 = dict(_kw)
checks.append(("--no-cv passes cv=False, --cv cv=True, default nothing", a1 == {"cv": False} and a2 == {"cv": True} and a3 == {}, [a1, a2, a3]))
# after a canvas page the next windows are hard negatives
_t = [_ev(0, "school.instructure.com/courses/1/modules"), _ev(5, "school.instructure.com/courses/1/assignments/9"),
      _ev(10, "school.instructure.com/courses/1/modules")]
_rows, _e, _taken = cli.mine([_t], __import__("random").Random(1))
checks += [("canvas hit, then modules: hit is positive, modules window is none",
            any(r["next_move"] == "canvas_study_bridge" and r["state"][-1].endswith("assignments/:id") for r in _rows)
            and any(r["next_move"] == "none" and r["state"][-1].endswith("/modules") and "after canvas" in r["why"] for r in _rows), _rows)]

bad = 0
for name, good, detail in checks:
    bad += not good
    print(("ok  " if good else "FAIL"), name, "" if good else json.dumps(detail, default=str)[:400])
shutil.rmtree(TMP)
sys.exit(bad)
