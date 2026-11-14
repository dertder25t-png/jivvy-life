#!/usr/bin/env python3
"""Lifeboard workflow training: mine rows from Firefox history, label edge cases, train laya.

  train_workflow_cli.py --mine [--days 60] [--profile P] [--out-dir D] [--seed-rng N] [--with-laya]
  train_workflow_cli.py --interactive [--no-train] [--out-dir D]
  train_workflow_cli.py --train [--device auto|cpu|cuda] [--no-cv | --cv] [--out-dir D]
  train_workflow_cli.py --import-sheet PATH [--no-cv | --cv] [--device ...]
  train_workflow_cli.py --stats [--out-dir D]

--mine reads a private copy of places.sqlite (pattern_miner does the copying and drops
sign-in pages), splits visits into sessions (a gap over 10 min starts a new one) and replays
the extension's five rules (extension/core/moves.js) over each session:
  frustration  2+ Google searches within 45 s, newest similar (Jaccard > 0.55) or over 12 words
  harvest      3+ searches on creative sites (Pinterest, stock photos) within 5 min
  canvas       an /courses/<id>/assignments|quizzes/<id> page on the Canvas (instructure) host
  nav          a short search that names the site you land on within 60 s
  calc         a unit or bitrate question ("157919mb to gb", "8tb at 400mbps")
It writes workflow_mined.jsonl (auto_pos / auto_neg rows) and workflow_edge_cases.jsonl
(near misses, unlabelled, with a "reason"). States are compact strings (helper/workflow_state.py).
Only counts are printed, never searches or addresses. Rows: docs/predictive-moves-contract.md.

--interactive shows each unlabelled edge case and reads one key:
  1 nav  2 frustration  3 canvas  4 creative  5 calc  n none  s skip  q save & train
Labels are appended at once to workflow_labels.jsonl (source "human").
--export-sheet PATH writes a Markdown review sheet (A: out-of-fold disagreements, B: edge cases and
rephrase bursts, C: unsure synthetic scenarios); fill the [ ] brackets (n 1 2 3 4) and run
--import-sheet PATH to append them to workflow_labels.jsonl (source human) and retrain.
--train merges seed + mined + labels (one row per state: human > seed > auto) and calls
laya_server.train_workflow(rows, device). Files are mode 600 in ~/.local/share/hub-dashboard.
"""
import os; os.environ.setdefault("HSA_OVERRIDE_GFX_VERSION", "10.3.0")  # RX 6700 XT (gfx1031)
import argparse
import json
import os
import random
import re
import shutil
import subprocess
import sys
import time
import urllib.request
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pattern_miner as pm  # noqa: E402
import workflow_state as ws  # noqa: E402

MOVES = ["nav_shortcut_interceptor", "search_frustration_escalator", "canvas_study_bridge",
         "creative_asset_router", "inline_unit_camera_calc"]
CALC_MOVE = "inline_unit_camera_calc"  # retired from Laya: its rows are labelled none
KEYS = {str(i + 1): m for i, m in enumerate(MOVES) if m != CALC_MOVE}
SEED_FILE, MINED_FILE = "workflow_training_seed.jsonl", "workflow_mined.jsonl"
EDGE_FILE, LABELS_FILE = "workflow_edge_cases.jsonl", "workflow_labels.jsonl"

SESSION_GAP = 600
MAX_EVENTS = ws.MAX_EVENTS
POS_CAP, NEG_CAP, NEG_RATIO, EDGE_CAP = 25, 60, 1.5, 60
POS_CAP_BY = {"canvas_study_bridge": 40}  # the page shape is the whole signal; keep more of them
NEAR_S = 300  # a negative window must be this far (s) from any rule or near miss

# extension/core/moves.js
FRUSTRATION_MS, FRUSTRATION_SIM, LONG_WORDS, SAME_SEARCH_S = 45, 0.55, 12, 5
NEAR_SIM = 0.25
HARVEST_N, HARVEST_S = 3, 300
NAV_S = 60
CREATIVE = {"pinterest", "pexels", "pixabay", "magnific", "freepik", "unsplash",
            "dreamstime", "shutterstock", "vecteezy", "freerangestock"}
CREATIVE_Q = re.compile(r"free image|free photo|stock image|illustration", re.I)
CREATIVE_NEAR_S = 120
HARD_NEG_CAP = 40
CANVAS_PATH = re.compile(r"^/courses/(?:\d+|:id)/(assignments|quizzes)/(?:\d+|:id)")

# extension/core/calc.js: the questions it answers
_NUM = r"(\d[\d,]*(?:\.\d+)?|\.\d+)"
_SIZE = r"(tib|gib|mib|kib|tb|gb|mb|kb|b)(?:ytes?)?"
_MASS = r"(kilograms?|kilos?|kgs?|grams?|g|pounds?|lbs?|ounces?|oz)"
_TO = r"\s*(?:to|in|as|->|=)\s*"
CALC_RES = [
    re.compile(rf"^{_NUM}\s*{_SIZE}{_TO}{_SIZE}\s*\??$"),
    re.compile(rf"^{_NUM}\s*{_MASS}{_TO}{_MASS}\s*\??$"),
    re.compile(rf"^{_NUM}\s*mah(?:\s*(?:at|@)\s*{_NUM}\s*v)?(?:\s*(?:to|in)\s*wh)?\s*\??$"),
    re.compile(rf"{_NUM}\s*{_SIZE}\s*(?:at|@)\s*{_NUM}\s*(gbps|mbps|kbps|gbit/s|mbit/s|kbit/s|gb/s|mb/s|kb/s)"),
]
XT4, ANY_SIZE = re.compile(r"\bx-?t4\b"), re.compile(rf"{_NUM}\s*(tb|gb)\b")


def is_calc(text):
    t = str(text or "").lower().strip()
    if not t or len(t) > 200 or not re.search(r"\d", t):
        return False
    return any(rx.search(t) for rx in CALC_RES) or bool(XT4.search(t) and ANY_SIZE.search(t))


def tokens(s):
    return re.findall(r"[^\W_]+", str(s or "").lower())


def similarity(a, b):
    """Jaccard of the word sets, like similarity() in moves.js."""
    A, B = set(tokens(a)), set(tokens(b))
    return len(A & B) / len(A | B) if A | B else 0.0


# ---- events and sessions ------------------------------------------------------------

def enrich(e):
    """Adds the compact string and what the rules need (engine, query) to a miner event."""
    s = ws.search_of(e["url"])
    engine = query = None
    if e.get("q") and pm.is_engine(e["host"]):  # google /search, duckduckgo, bing /search
        engine = "google" if e["host"].startswith("google.") else e["host"].split(".")[0]
        query = e["q"]
    elif s and s[0] in CREATIVE and (s[0] != "pinterest" or e["path"].startswith("/search/")):
        engine, query = s
    return {**e, "c": ws.compact_url(e["url"]), "engine": engine, "query": query}


def build_sessions(events, gap=SESSION_GAP):
    """Sessions of enriched events; the same compact event again within 5 s counts once."""
    out = []
    for sess in pm.split_sessions(events, gap):
        cur = []
        for e in map(enrich, sess):
            if cur and cur[-1]["c"] == e["c"] and e["t"] - cur[-1]["t"] < SAME_SEARCH_S:
                continue
            cur.append(e)
        if cur:
            out.append(cur)
    return out


def window(sess, i, n=MAX_EVENTS):
    return [e["c"] for e in sess[max(0, i - n + 1):i + 1]]


# ---- the rules ------------------------------------------------------------------------

def google_recent(sess, i):
    """Distinct Google searches within 45 s up to event i (isFrustration's `recent`)."""
    s = []
    for e in sess[:i + 1]:
        if e["engine"] != "google" or not e["query"]:
            continue
        if s and s[-1]["query"] == e["query"] and e["t"] - s[-1]["t"] < SAME_SEARCH_S:
            continue
        s.append(e)
    newest = sess[i]
    return [e for e in s if newest["t"] - e["t"] <= FRUSTRATION_MS]


def frustration(sess, i):
    """'fire', 'near' (Jaccard 0.25..0.55), or None at event i."""
    e = sess[i]
    if e["engine"] != "google" or not e["query"]:
        return None
    recent = google_recent(sess, i)
    if len(recent) < 2 or recent[-1] is not e:
        return None
    best = max(similarity(x["query"], e["query"]) for x in recent[:-1])
    if best > FRUSTRATION_SIM or len(tokens(e["query"])) > LONG_WORDS:
        return "fire"
    return "near" if best >= NEAR_SIM else None


BURST_N, BURST_S = 3, 90


def rephrase_burst(sess, i):
    """True at event i when it is the 3rd+ Google search within 90 s, whatever the word overlap
    (the frustration rule needs similarity; this catches a semantic rephrase like
    "cheap flights lisbon" -> "best time to visit portugal" -> "portugal visa")."""
    e = sess[i]
    if e["engine"] != "google" or not e["query"]:
        return False
    qs = [x for x in sess[:i + 1] if x["engine"] == "google" and x["query"] and e["t"] - x["t"] <= BURST_S]
    return len({x["query"] for x in qs}) >= BURST_N


def rephrase_bursts(sessions):
    """Windows ending at a rephrase burst that the frustration rule did not fire on."""
    out = {}
    for sess in sessions:
        for i in range(len(sess)):
            if rephrase_burst(sess, i) and frustration(sess, i) != "fire":
                st = tuple(window(sess, i))
                out.setdefault(st, {"state": list(st), "reason": "rephrase_burst", "near": "search_frustration_escalator"})
    return [out[k] for k in sorted(out)]


def creative_visit(e):
    return e["engine"] in CREATIVE or any(l in CREATIVE for l in e["host"].split("."))


def creative_google(sess, i):
    """True if the Google query at event i is stock-image hunting, not frustration: it says
    "free image/photo", "stock image" or "illustration", or comes within 120 s of a creative-site
    visit. Applies however long the query is (twin of isCreativeGoogle in moves.js)."""
    e = sess[i]
    if e["engine"] != "google" or not e["query"]:
        return False
    if CREATIVE_Q.search(e["query"]):
        return True
    return any(creative_visit(x) and 0 <= e["t"] - x["t"] <= CREATIVE_NEAR_S for x in sess[:i])


def creative_times(sess):
    return [e["t"] for e in sess if e["engine"] in CREATIVE and e["query"]]


def harvest(sess, i, times):
    """'fire' (3+ creative searches in the last 5 min), 'near' (exactly 2, and no third
    follows within 5 min of the first), or None at event i."""
    e = sess[i]
    if e["engine"] not in CREATIVE or not e["query"]:
        return None
    n = sum(1 for t in times if e["t"] - HARVEST_S <= t <= e["t"])
    if n >= HARVEST_N:
        return "fire"
    if n == 2:
        first = min(t for t in times if e["t"] - HARVEST_S <= t <= e["t"])
        if sum(1 for t in times if first <= t <= first + HARVEST_S) == 2:
            return "near"
    return None


def canvas(e, host=None):
    ok_host = e["host"] == host if host else e["host"].endswith(".instructure.com")
    return ok_host and bool(CANVAS_PATH.match(e["path"]))


def nav_landing(sess, i):
    """True if event i is the site a short search just before (<= 60 s) named. Only the last 3
    events count (this one and the 2 before it), so earlier unrelated pages don't matter."""
    e = sess[i]
    if e["engine"] or pm.is_engine(e["host"]):
        return False
    for j in range(i - 1, max(-1, i - 3), -1):
        s = sess[j]
        if e["t"] - s["t"] > NAV_S:
            return False
        if not pm.is_engine(s["host"]):
            return False  # another page came between
        q = s["q"]
        if q:
            return len(q) <= 40 and len(q.split()) <= 4 and not is_calc(q) and pm.names_host(q, e["host"])
    return False


def _split(c):
    host, _, path = c.partition("/")
    return host, "/" + path


def canvas_state(state, host=None):
    """canvas_study_bridge fires only when the NEWEST event is an assignment or quiz page;
    going on to /modules afterwards is not it."""
    if not state:
        return False
    h, path = _split(state[-1])  # compact form: "canvas/courses/:id/assignments/:id"
    return (ws.is_canvas_host(h) if not host else h in (host, "canvas")) and bool(CANVAS_PATH.match(path))


def nav_state(state):
    """nav_shortcut_interceptor on a compact state, from its last 3 events only: the newest is a
    plain page and the nearest search before it is a short query that names that site."""
    if len(state) < 2 or ":q=" in state[-1] or state[-1].startswith("dl:"):
        return False
    h, _ = _split(state[-1])
    if pm.is_engine(h):
        return False
    for c in reversed(state[-3:-1]):
        eng, _, q = c.partition(":q=")
        if q and eng in ("google", "duckduckgo", "bing"):
            return len(q) <= 40 and len(q.split()) <= 4 and not is_calc(q) and pm.names_host(q, h)
        if not pm.is_engine(_split(c)[0]):
            return False  # another page came between
    return False


def rule_label(state, canvas_host=None):
    """The move the rules pick for a compact state judged on its newest events, else None."""
    if canvas_state(state, canvas_host):
        return "canvas_study_bridge"
    if nav_state(state):
        return "nav_shortcut_interceptor"
    return None


def scan(sess, canvas_host=None):
    """[(index, move id | None, kind)] with kind 'fire' or a near-miss reason."""
    times = creative_times(sess)
    out = []
    for i, e in enumerate(sess):
        if canvas(e, canvas_host):
            out.append((i, "canvas_study_bridge", "fire"))
        elif e["engine"] in ("google", "duckduckgo", "bing") and is_calc(e["query"]):
            out.append((i, "inline_unit_camera_calc", "fire"))
        elif nav_landing(sess, i):
            out.append((i, "nav_shortcut_interceptor", "fire"))
        else:
            f = frustration(sess, i)
            h = harvest(sess, i, times)
            if f and creative_google(sess, i):  # stock-image hunting, however many words
                out.append((i, "creative_asset_router", "fire" if f == "fire" else "harvest_near_miss"))
            elif f == "fire":
                out.append((i, "search_frustration_escalator", "fire"))
            elif h == "fire":
                out.append((i, "creative_asset_router", "fire"))
            elif f == "near":
                out.append((i, "search_frustration_escalator", "frustration_near_miss"))
            elif h == "near":
                out.append((i, "creative_asset_router", "harvest_near_miss"))
    return out


# ---- --mine -----------------------------------------------------------------------------

def mine(sessions, rng, canvas_host=None):
    """(mined rows, edge rows, stats)."""
    pos = {m: {} for m in MOVES}
    edges = {"frustration_near_miss": {}, "harvest_near_miss": {}}
    neg_pool, hard = {}, {}
    for sess in sessions:
        hits = scan(sess, canvas_host)
        for i, move, kind in hits:
            st = tuple(window(sess, i))
            if kind == "fire" and move == CALC_MOVE:  # core/calc.js answers it; Laya's label is none
                pos[move].setdefault(st, {"state": list(st), "next_move": "none", "should_stage": False,
                                          "source": "auto_neg", "why": "calc (core/calc.js)"})
            elif kind == "fire":
                pos[move].setdefault(st, {"state": list(st), "next_move": move, "should_stage": True,
                                          "source": "auto_pos", "why": "rule"})
            else:
                edges[kind].setdefault(st, {"state": list(st), "reason": kind, "near": move})
        busy = [sess[i]["t"] for i, _m, _k in hits]
        for i, move, kind in hits:  # the 1st/2nd event after an assignment or quiz (e.g. /modules) is not it
            if move == "canvas_study_bridge" and kind == "fire":
                for k in (1, 2):
                    if i + k < len(sess) and not canvas(sess[i + k], canvas_host):
                        st = tuple(window(sess, i + k))
                        hard.setdefault(st, {"state": list(st), "next_move": "none", "should_stage": False,
                                             "source": "auto_neg", "why": "after canvas page"})
        for i in range(len(sess)):
            for n in (4, 5):
                if i + 1 < n:
                    continue
                t0, t1 = sess[i - n + 1]["t"], sess[i]["t"]
                if any(t0 - NEAR_S <= t <= t1 + NEAR_S for t in busy):
                    continue
                st = tuple(window(sess, i, n))
                neg_pool.setdefault(st, {"state": list(st), "next_move": "none", "should_stage": False,
                                         "source": "auto_neg", "why": "no rule"})
    taken = set()
    rows = []
    for move in MOVES:
        cands = [r for st, r in sorted(pos[move].items()) if st not in taken]
        rng.shuffle(cands)
        for r in cands[:POS_CAP_BY.get(move, POS_CAP)]:
            taken.add(tuple(r["state"]))
            rows.append(r)
    n_pos = len(rows)
    hard_rows = [r for st, r in sorted(hard.items()) if st not in taken]
    rng.shuffle(hard_rows)
    for r in hard_rows[:HARD_NEG_CAP]:
        taken.add(tuple(r["state"]))
        rows.append(r)
    n_neg = min(NEG_CAP, round(NEG_RATIO * n_pos))
    negs = [r for st, r in sorted(neg_pool.items()) if st not in taken]
    rng.shuffle(negs)
    for r in negs[:n_neg]:
        taken.add(tuple(r["state"]))
        rows.append(r)
    edge_rows = interleave([[r for st, r in sorted(d.items()) if st not in taken] for d in edges.values()], rng)
    return rows, edge_rows, taken


def interleave(groups, rng):
    """Shuffled within each group, then taken in turns."""
    for g in groups:
        rng.shuffle(g)
    out = []
    while any(groups):
        for g in groups:
            if g:
                out.append(g.pop(0))
    return out


def laya_next(state, token):
    body = json.dumps({"state": state, "moves": MOVES}).encode()
    req = urllib.request.Request(pm.LAYA_URL, data=body, method="POST",
                                 headers={"Content-Type": "application/json", "X-Hub-Token": token})
    with urllib.request.urlopen(req, timeout=20) as r:
        reply = json.loads(r.read())
    nm = reply.get("next_move") if reply.get("ok") else None
    if not isinstance(nm, dict):
        raise ValueError("no next_move")
    return nm.get("choice"), float(nm.get("p"))


def laya_edges(sessions, taken, rng, limit, budget):
    """Edge rows where laya's next_move is unsure (0.45 <= p <= 0.80), or None if laya can't answer."""
    try:
        token = pm.TOKEN.read_text().strip()
    except OSError:
        return None
    if not token:
        return None
    pool = {}
    for sess in sessions:
        for i in range(len(sess)):
            st = tuple(window(sess, i))
            if len(st) >= 2 and st not in taken:
                pool[st] = True
    cands = sorted(pool)
    rng.shuffle(cands)
    out = []
    for k, st in enumerate(cands[:budget]):
        try:
            choice, p = laya_next(list(st), token)
        except Exception:
            if k == 0:
                return None  # not running, or no /workflow yet
            continue
        if 0.45 <= p <= 0.80:
            out.append({"state": list(st), "reason": "laya_unsure", "laya": {"choice": choice, "p": round(p, 3)}})
            if len(out) >= limit:
                break
    return out


def jsonl(rows):
    return "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows)


def cmd_mine(a, data):
    profile = Path(a.profile) if a.profile else pm.find_profile()
    if not profile or not (profile / "places.sqlite").is_file():
        print("No Firefox profile with places.sqlite found (use --profile).", file=sys.stderr)
        return 1
    events = pm.events_from(pm.load_visits(profile, max(1, min(a.days, 365)), time.time()))
    sessions = build_sessions(events)
    rng = random.Random(a.seed_rng)
    rows, edges, taken = mine(sessions, rng, a.canvas_host)
    taken |= {tuple(r["state"]) for r in edges}
    bursts = [r for r in rephrase_bursts(sessions) if tuple(r["state"]) not in taken]
    rng.shuffle(bursts)
    edges = edges[:EDGE_CAP - min(len(bursts), 15)] + bursts[:15]
    taken |= {tuple(r["state"]) for r in edges}
    laya_note = "not asked (use --with-laya)"
    if a.with_laya:
        room = max(0, EDGE_CAP - min(len(edges), EDGE_CAP * 2 // 3))
        extra = laya_edges(sessions, taken, rng, room, a.laya_budget)
        if extra is None:
            laya_note = "not reachable, skipped"
        else:
            laya_note = f"{len(extra)} unsure windows"
            edges = interleave([edges[:EDGE_CAP - len(extra)], extra], rng) if extra else edges
    edges = edges[:EDGE_CAP]
    pm.write_private_text(data / MINED_FILE, jsonl(rows))
    pm.write_private_text(data / EDGE_FILE, jsonl(edges))
    c = Counter(r["next_move"] if r["source"] == "auto_pos" else "auto_neg" for r in rows)
    print(f"events: {len(events)}  sessions: {len(sessions)}")
    print(f"{MINED_FILE}: {len(rows)} rows")
    for m in MOVES + ["auto_neg"]:
        print(f"  {m}: {c.get(m, 0)}")
    e = Counter(r["reason"] for r in edges)
    print(f"{EDGE_FILE}: {len(edges)} rows")
    for k in ("frustration_near_miss", "harvest_near_miss", "rephrase_burst", "laya_unsure"):
        print(f"  {k}: {e.get(k, 0)}")
    print(f"laya: {laya_note}")
    return 0


# ---- files ------------------------------------------------------------------------------

def read_jsonl(path):
    rows = []
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if isinstance(r, dict) and isinstance(r.get("state"), list) and all(isinstance(s, str) for s in r["state"]):
                    rows.append(r)
    except OSError:
        pass
    return rows


def append_private(path, row):
    path = Path(path)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    try:
        os.fchmod(fd, 0o600)
        os.write(fd, (json.dumps(row, ensure_ascii=False) + "\n").encode())
        os.fsync(fd)
    finally:
        os.close(fd)


# ---- --interactive ---------------------------------------------------------------------------

class Keys:
    """One key at a time: raw mode on a terminal, else characters from piped lines."""

    def __init__(self, stream=sys.stdin):
        self.stream, self.buf = stream, []
        try:
            self.tty = stream.isatty()
        except (AttributeError, ValueError):
            self.tty = False

    def get(self):
        if self.tty:
            import termios
            import tty
            fd = self.stream.fileno()
            old = termios.tcgetattr(fd)
            try:
                tty.setraw(fd)
                ch = os.read(fd, 1).decode(errors="replace")
            finally:
                termios.tcsetattr(fd, termios.TCSADRAIN, old)
            return None if ch in ("\x03", "\x04") else ch.lower()
        while not self.buf:
            line = self.stream.readline()
            if not line:
                return None
            self.buf = [c for c in line if not c.isspace()]
        return self.buf.pop(0).lower()


def cmd_interactive(a, data):
    edges = read_jsonl(data / EDGE_FILE)
    done = {tuple(r["state"]) for r in read_jsonl(data / LABELS_FILE)}
    total = len(edges)
    todo, seen = [], set(done)
    for r in edges:
        st = tuple(r["state"])
        if st not in seen:
            seen.add(st)
            todo.append(r)
    n_done = total - len(todo)
    if not todo:
        print(f"Nothing to label ({total} edge cases, all labelled).")
        return 0
    keys, out = Keys(), sys.stdout
    legend = "  ".join(f"{k} {m}" for k, m in KEYS.items()) + "  n none  s skip  q save & train"
    labelled, train = 0, False
    for k, r in enumerate(todo):
        print(f"\n[{n_done + k + 1}/{total}]  reason: {r.get('reason', '?')}", file=out)
        for j, ev in enumerate(r["state"], 1):
            print(f"  {j}. {ev}", file=out)
        print(legend, file=out)
        out.flush()
        while True:
            ch = keys.get()
            if ch is None or ch == "q" or ch == "s" or ch == "n" or ch in KEYS:
                break
        if ch is None:
            break
        if ch == "q":
            train = True
            break
        if ch == "s":
            print("  skipped", file=out)
            continue
        row = {"state": r["state"], "next_move": KEYS.get(ch, "none"), "should_stage": ch in KEYS,
               "source": "human", "why": r.get("reason", "")}
        append_private(data / LABELS_FILE, row)
        labelled += 1
        print(f"  -> {row['next_move']}", file=out)
    print(f"\nLabelled {labelled} this time ({LABELS_FILE}).", file=out)
    if train and not a.no_train:
        return cmd_train(a, data)
    return 0


# ---- --train / --stats ------------------------------------------------------------------------

RANK = {"human": 3, "seed": 2, "auto_pos": 1, "auto_neg": 1}


def gather(data):
    """One row per state; on conflicts human > seed > auto (a later row wins a tie)."""
    best = {}
    for name, source in ((SEED_FILE, "seed"), (MINED_FILE, None), (LABELS_FILE, "human")):
        for r in read_jsonl(data / name):
            if not isinstance(r.get("next_move"), str) or not isinstance(r.get("should_stage"), bool):
                continue
            if r["next_move"] == CALC_MOVE:
                r = {**r, "next_move": "none", "should_stage": False}
            r = {**r, "source": source or r.get("source", "auto_pos")}
            st = tuple(ws.normalize_state(r["state"][-MAX_EVENTS:]))  # old canvas strings re-keyed
            r["state"] = list(st)
            old = best.get(st)
            if old is None or RANK.get(r["source"], 0) >= RANK.get(old["source"], 0):
                best[st] = r
    return list(best.values())


def cmd_train(a, data):
    rows = gather(data)
    print(f"training rows: {len(rows)}")
    for (m, s), n in sorted(Counter((r["next_move"], r["should_stage"]) for r in rows).items()):
        print(f"  {m} (stage={str(s).lower()}): {n}")
    for s, n in sorted(Counter(r["source"] for r in rows).items()):
        print(f"  from {s}: {n}")
    train = None
    try:
        import laya_server
        train = getattr(laya_server, "train_workflow", None)
    except Exception as e:  # being edited, or its dependencies are missing
        print(f"laya_server could not be loaded: {type(e).__name__}", file=sys.stderr)
    if not callable(train):
        print("Workflow training isn't available yet (laya_server.train_workflow is missing).", file=sys.stderr)
        return 2
    kw = {"cv": False} if getattr(a, "no_cv", False) else {"cv": True} if getattr(a, "cv", False) else {}
    try:
        result = train(rows, getattr(a, "device", "auto") or "auto", **kw)
    finally:
        try:        # the training model is already gone (laya_server.train_workflow frees it); sweep what is left
            laya_server.free_torch("cuda" if laya_server.resolve_device(getattr(a, "device", "auto") or "auto") == "cuda" else "cpu")
        except Exception:
            pass
    try:
        print(json.dumps(result, default=str)[:2000])
    except (TypeError, ValueError):
        print(str(result)[:2000])
    failed = isinstance(result, dict) and result.get("ok") is False
    if not failed and os.environ.get("LAYA_OV_AUTOEXPORT", "1") != "0":
        # the reader is frozen, so this is a no-op unless the OpenVINO IR is missing or its hash no longer matches;
        # export and device selection each run in their own memory-capped process. Restart hub-laya afterwards:
        # it loads the fit and the IR at startup (and clears its answer cache then).
        # (laya_ov.ensure_export runs the export/select steps as capped child processes, never in this one.)
        try:
            import laya_ov
            laya_ov.ensure_export()
        except Exception as e:
            print(f"laya-ov skipped: {type(e).__name__}: {e}", file=sys.stderr)
    if not failed:
        reload_service()
    return 1 if failed else 0


def reload_service():
    """Restart hub-laya (if it runs) so it loads the new fit and OpenVINO IR in a fresh process that never held
    the training model's torch weights. LAYA_RELOAD=0 skips it."""
    import gc
    gc.collect()
    if os.environ.get("LAYA_RELOAD", "1") == "0" or not shutil.which("systemctl"):
        return
    try:
        r = subprocess.run(["systemctl", "--user", "try-restart", "hub-laya"], capture_output=True, text=True, timeout=120)
        print("hub-laya reloaded" if r.returncode == 0 else f"hub-laya reload skipped: {r.stderr.strip()[:120]}")
    except Exception as e:
        print(f"hub-laya reload skipped: {type(e).__name__}", file=sys.stderr)


def cmd_stats(a, data):
    for name in (SEED_FILE, MINED_FILE, EDGE_FILE, LABELS_FILE):
        rows = read_jsonl(data / name)
        print(f"{name}: {len(rows)} rows")
        if name == EDGE_FILE:
            done = {tuple(r["state"]) for r in read_jsonl(data / LABELS_FILE)}
            for k, n in sorted(Counter(r.get("reason", "?") for r in rows).items()):
                print(f"  {k}: {n}")
            print(f"  labelled: {sum(1 for r in rows if tuple(r['state']) in done)}")
            continue
        for (m, s), n in sorted(Counter((r.get("next_move"), r.get("source")) for r in rows).items(), key=str):
            print(f"  {m} [{s}]: {n}")
    return 0


# ---- --export-sheet / --import-sheet ---------------------------------------------------------

import hashlib

SHEET_CODES = {"n": "none", **KEYS}  # n none, 1 nav, 2 frustration, 3 canvas, 4 creative
UNSURE_LO, UNSURE_HI, SECTION_C_MAX = 0.40, 0.84, 25
# one line per item:  - [ ] `<id>` <!--["event", ...]-->   (the comment carries the state for --import-sheet)
ITEM_RE = re.compile(r"^\s*[-*]\s*\[\s*([^\]\s]?)\s*\]\s*`?([A-Za-z]-[0-9a-f]{10})`?\s*<!--(.*?)-->", re.M)


def item_id(section, state):
    return f"{section}-{hashlib.sha1(chr(10).join(state).encode()).hexdigest()[:10]}"


def parse_sheet(text):
    """[(id, code, state)] for every item with a filled, valid bracket (n, 1-4); blanks and
    unknown codes are skipped, the first of a repeated id wins."""
    out, seen = [], set()
    for m in ITEM_RE.finditer(text):
        code, iid, raw = m.group(1).lower(), m.group(2), m.group(3)
        if code not in SHEET_CODES or iid in seen:
            continue
        try:
            state = json.loads(raw)
        except ValueError:
            continue
        if not (isinstance(state, list) and state and all(isinstance(s, str) for s in state)):
            continue
        seen.add(iid)
        out.append((iid, code, state))
    return out


def sheet_row(code, state, iid):
    move = SHEET_CODES[code]
    return {"state": ws.normalize_state(state[-MAX_EVENTS:]), "next_move": move, "should_stage": move != "none",
            "source": "human", "why": f"sheet {iid}"}


def import_rows(entries, existing_states):
    """Label rows for parsed sheet entries whose state is not already in workflow_labels.jsonl."""
    rows, seen = [], set(existing_states)
    for iid, code, state in entries:
        st = tuple(ws.normalize_state(state[-MAX_EVENTS:]))
        if st in seen:
            continue
        seen.add(st)
        rows.append(sheet_row(code, state, iid))
    return rows


def cmd_import_sheet(a, data):
    try:
        text = Path(a.import_sheet).expanduser().read_text(encoding="utf-8")
    except OSError as e:
        print(f"cannot read the sheet: {e.strerror}", file=sys.stderr)
        return 1
    entries = parse_sheet(text)
    have = {tuple(ws.normalize_state(r["state"][-MAX_EVENTS:])) for r in read_jsonl(data / LABELS_FILE)}
    rows = import_rows(entries, have)
    for r in rows:
        append_private(data / LABELS_FILE, r)
    print(f"sheet: {len(entries)} filled, {len(rows)} new labels appended, {len(entries) - len(rows)} already labelled")
    if not rows and not entries:
        return 0
    a.device = getattr(a, "device", "auto") or "auto"
    return cmd_train(a, data)


def _label_of(r):
    return r["next_move"] if r["should_stage"] else "none"


def synthetic_scenarios(rng, n=300):
    """Plausible 3-5 event states over the four moves and none, built from small word lists."""
    topics = ["lens", "tent", "mortgage rates", "python decorator", "sourdough", "visa lisbon", "bike tire",
              "ssd health", "tax form", "vpn router", "gpu driver", "keyboard switch", "wifi dropout",
              "plant fertilizer", "film stock"]
    sites = ["youtube.com/", "reddit.com/r/photography", "github.com/", "news.ycombinator.com/", "amazon.com/",
             "wikipedia.org/wiki/Main", "docs.python.org/3/", "weather.com/", "nytimes.com/", "stackoverflow.com/"]
    short = {"yt": "youtube.com/", "gh": "github.com/", "fb": "facebook.com/", "mail": "mail.google.com/mail/u/0/",
             "maps": "maps.google.com/", "red": "reddit.com/"}
    crea = ["pinterest", "pexels", "unsplash", "freepik", "pixabay"]
    look = ["retro logo", "poster typography", "mixer board", "film grain", "paper texture", "gig flyer", "icon set"]
    out = []
    for _ in range(n):
        kind, tp = rng.choice(["frust", "frust_sem", "nav", "canvas", "crea", "none", "mixed", "mixed"]), rng.choice(topics)
        if kind == "frust":
            w = tp.split()
            s = [f"google:q={tp}", f"google:q={tp} not working", f"google:q=why {tp} {rng.choice(['fails', 'slow', 'wrong'])}"]
        elif kind == "frust_sem":
            a, b = rng.sample(topics, 2)
            s = [f"google:q={a}", f"google:q=best {b} guide", f"google:q={tp} help"]
        elif kind == "nav":
            k = rng.choice(list(short))
            s = [f"google:q={k}", short[k]] * rng.choice([1, 2])
        elif kind == "canvas":
            c, x = rng.randint(1, 900), rng.randint(1, 900)
            s = [rng.choice(sites), f"school.instructure.com/courses/{c}/{rng.choice(['assignments', 'quizzes'])}/{x}",
                 f"school.instructure.com/courses/{c}/modules"][rng.randint(0, 1):]
        elif kind == "crea":
            s = [f"{rng.choice(crea)}:q={rng.choice(look)}" for _ in range(rng.choice([2, 3, 3]))]
            if rng.random() < .5:
                s.append(f"dl:{rng.choice(look).replace(' ', '_')}.jpg")
        elif kind == "none":
            s = rng.sample(sites, rng.choice([1, 2, 3]))
        else:
            s = rng.sample(sites, 2) + [f"google:q={tp}"] + rng.sample(sites, rng.choice([0, 1]))
        out.append(s[-MAX_EVENTS:])
    seen, uniq = set(), []
    for s in out:
        if tuple(s) not in seen:
            seen.add(tuple(s))
            uniq.append(s)
    return uniq


def pick_unsure(scored, limit=SECTION_C_MAX, rng=None):
    """scored: [(state, guess, p)]. Those with p in [0.40, 0.84], spread round-robin over the guesses."""
    by = {}
    for st, guess, p in scored:
        if UNSURE_LO <= p <= UNSURE_HI:
            by.setdefault(guess, []).append((st, guess, p))
    for g in by.values():
        (rng or random.Random(0)).shuffle(g)
    out = []
    while len(out) < limit and any(by.values()):
        for g in sorted(by):
            if by[g] and len(out) < limit:
                out.append(by[g].pop())
    return out


def _fmt(state, iid, extra):
    lines = [f"- [ ] `{iid}` <!--{json.dumps(state).replace('>', chr(92) + 'u003e').replace('<', chr(92) + 'u003c')}-->  {extra}".rstrip()]
    lines += [f"    {j}. `{ev}`" for j, ev in enumerate(state, 1)]
    return "\n".join(lines)


def cmd_export_sheet(a, data):
    here = Path(__file__).resolve().parent
    sys.path.insert(0, str(here))
    import laya_server as ls
    rows = ls.dedupe_rows(gather(data))
    human = {tuple(r["state"]) for r in read_jsonl(data / LABELS_FILE)}
    legend = "  ".join(f"`{c}` {m}" for c, m in SHEET_CODES.items())
    # out-of-fold predictions: the last training run's, or a fresh honest cross-validation
    oof_path = ls.WORKFLOW_FIT_DIR / "oof.json"
    try:
        oof = json.loads(oof_path.read_text())
    except (OSError, ValueError):
        oof = None
    model = ls.Model("vega", 8, getattr(a, "device", "auto") or "auto")
    model.load()
    if model.agent is None:
        print(f"laya could not load: {model.error}", file=sys.stderr)
        return 1
    if oof is None:
        qs = ls.fit_questions()
        oof = ls.cross_validate(model.agent, rows, qs)["oof"]
        model.load_workflow(model.agent)  # the CV refit its heads; put the saved ones back
    A = [o for o in oof if o.get("source") in ("auto_pos", "auto_neg", "seed") and o["label"] != o["guess"]
         and tuple(o["state"]) not in human]
    A.sort(key=lambda o: -o["p"])
    # B: unlabelled edge cases, plus rephrase bursts from the history (best effort)
    B, seen = [], set(human)
    for r in read_jsonl(data / EDGE_FILE):
        st = tuple(r["state"])
        if st not in seen:
            seen.add(st)
            B.append(r)
    try:
        profile = Path(a.profile) if getattr(a, "profile", None) else pm.find_profile()
        if profile and (profile / "places.sqlite").is_file():
            ev = pm.events_from(pm.load_visits(profile, max(1, min(a.days, 365)), time.time()))
            for r in rephrase_bursts(build_sessions(ev)):
                st = tuple(r["state"])
                if st not in seen:
                    seen.add(st)
                    B.append(r)
    except Exception as e:
        print(f"history not read for rephrase bursts: {type(e).__name__}", file=sys.stderr)
    # C: unsure multi-step scenarios
    rng = random.Random(a.seed_rng)
    pool = [s for s in synthetic_scenarios(rng) if tuple(s) not in seen and len(s) >= 2]
    scored = []
    for s in pool:
        r = model.workflow(s, MOVES[:4])
        if r.get("ok"):
            nm = r["next_move"]
            scored.append((s, nm["choice"], nm["p"]))
    C = pick_unsure(scored, SECTION_C_MAX, rng)
    out = ["# Lifeboard workflow review sheet", "",
           "Fill each bracket with a code, then run `train_workflow_cli.py --import-sheet <this file>`. "
           "Leave `[ ]` blank to skip. Do not edit the ids or the `<!-- -->` comments.", "",
           f"Codes: {legend}", "",
           f"## A. Disagreements ({len(A)})", "",
           "Out-of-fold guess differs from the current auto or seed label. Is the label right (use its code) "
           "or the guess?", ""]
    for o in A:
        out.append(_fmt(o["state"], item_id("A", o["state"]),
                        f"label **{o['label']}** ({o['source']}), guess **{o['guess']}** @ {o['p']:.2f}"))
    out += ["", f"## B. Edge cases and rephrase bursts ({len(B)})", ""]
    for r in B:
        out.append(_fmt(r["state"], item_id("B", r["state"]), f"reason {r.get('reason', '?')}"))
    out += ["", f"## C. Unsure scenarios ({len(C)})", "",
            f"Laya's confidence in its guess is between {UNSURE_LO:.2f} and {UNSURE_HI:.2f}.", ""]
    for st, guess, p in C:
        out.append(_fmt(st, item_id("C", st), f"guess **{guess}** @ {p:.2f}"))
    pm.write_private_text(Path(a.export_sheet).expanduser(), "\n".join(out) + "\n")
    print(f"sheet {a.export_sheet}: A {len(A)}  B {len(B)}  C {len(C)}")
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description="Mine, label and train Lifeboard's workflow model.")
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--mine", action="store_true")
    mode.add_argument("--interactive", action="store_true")
    mode.add_argument("--train", action="store_true")
    mode.add_argument("--stats", action="store_true")
    mode.add_argument("--export-sheet", metavar="PATH")
    mode.add_argument("--import-sheet", metavar="PATH")
    ap.add_argument("--days", type=int, default=60)
    ap.add_argument("--profile", help="Firefox profile folder (default: found via profiles.ini)")
    ap.add_argument("--out-dir", help="data folder (default: ~/.local/share/hub-dashboard)")
    ap.add_argument("--seed-rng", type=int, default=1234, help="random seed for sampling")
    ap.add_argument("--canvas-host", help="Canvas host (default: any *.instructure.com)")
    ap.add_argument("--with-laya", action="store_true", help="also ask laya for unsure windows")
    ap.add_argument("--laya-budget", type=int, default=80, help="most windows to ask laya about")
    ap.add_argument("--device", choices=["auto", "cpu", "cuda"], default="auto")
    ap.add_argument("--no-cv", action="store_true", help="--train/--import-sheet: skip the cross-validation folds (faster)")
    ap.add_argument("--cv", action="store_true", help="--train/--import-sheet: run the cross-validation folds (the default)")
    ap.add_argument("--no-train", action="store_true", help="--interactive: q saves but doesn't train")
    a = ap.parse_args(argv)
    if a.cv and a.no_cv:
        ap.error("--cv and --no-cv are exclusive")
    data = Path(a.out_dir).expanduser() if a.out_dir else pm.DATA
    if a.canvas_host:
        ws.CANVAS_HOSTS.add(a.canvas_host.lower())
    if a.mine:
        return cmd_mine(a, data)
    if a.interactive:
        return cmd_interactive(a, data)
    if a.train:
        return cmd_train(a, data)
    if a.export_sheet:
        return cmd_export_sheet(a, data)
    if a.import_sheet:
        return cmd_import_sheet(a, data)
    return cmd_stats(a, data)


if __name__ == "__main__":
    sys.exit(main())
