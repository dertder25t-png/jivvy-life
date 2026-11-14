#!/usr/bin/env python3
"""Hub Dashboard decision service: asks a laya model where a request should go.

Keeps the model loaded and answers on 127.0.0.1 only. The dashboard calls it when you
press Enter and its own quick model isn't sure, to decide between Google and an AI chat.

  POST /decide  {"text": "..."}  ->  {"ok": true, "p_ai": 0.62, "probs": {"google": 0.38, "ai": 0.62}, "ms": 350}
  POST /workflow {"state": ["google:q=a", "google:q=b"] | "<plain text>", "moves": ["<enabled move id>", ...]}
                 ->  {"ok": true, "should_stage": {"choice": "yes"|"no"|"unsure", "p": .., "route": ..},
                      "next_move": {"choice": "<id>"|"none", "p": .., "probs": {..}, "route": ..}, "ms": 800}
                 (p is the probability of the chosen answer; see docs/predictive-moves-contract.md)
  GET  /health                   ->  {"ok": true, "model": "...", "ready": true, "device": "cpu", "workflow": {..}}

Only the dashboard extension may call it: requests must come from a moz-extension:// page
and be addressed to 127.0.0.1 / localhost (blocks other websites and DNS rebinding).
/workflow also accepts local programs that send X-Hub-Token equal to ~/.config/hub-dashboard/laya-token
(no file -> no token access).

Settings: ~/.config/hub-dashboard/laya.json
  model  "vega" (default): laya's 0.8B reader, trained in about 2 minutes on tools/seed.jsonl
         plus ~/.config/hub-dashboard/labels.jsonl if you add one ({"text": ..., "cls": "search"|"ask"} per line).
         The training is saved and redone only when those files change.
         Or a laya checkpoint id, e.g. "convaiinnovations/laya-typed-decisions" (no training).
  port   default 8770
  threads  CPU threads for the model (default 8; all 16 made training several times slower here)
  device "auto" (default: CUDA when torch sees a GPU -- ROCm builds report through torch.cuda too --
         else CPU), "cpu" or "cuda". A "cuda" that isn't there falls back to CPU.

Workflow fit: `laya_server.py --train-workflow FILE.jsonl ...` (or train_workflow(rows) from Python)
fits a head on workflow training rows and saves it to ~/.local/share/hub-dashboard/workflow-fit/,
next to -- never inside -- vega-fit/. The service loads it at startup into the same model (one
process, one copy of vega): heads are kept per question id, and the workflow calibration is held
apart and swapped in only for /workflow calls, so /decide answers are untouched. Without a fit,
/workflow answers zero-shot.

On 30 typical searches, with the dashboard's own classifier deciding the clear ones:
vega trained 97%, laya-typed-decisions 93%, classifier alone 90%.
"""
import collections
import contextlib
import hashlib
import hmac
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

os.environ.setdefault("HSA_OVERRIDE_GFX_VERSION", "10.3.0")  # RX 6700 XT (gfx1031) -> gfx1030 kernels
if __name__ == "__main__" and os.environ.get("LAYA_DEVICE", "cpu").lower() != "cuda":
    # The persistent service stays on CPU so an eGPU hot-unplug can't take it down. Training
    # (helper/train_workflow_cli.py imports this module) is not __main__ and keeps the GPU visible.
    os.environ.setdefault("HIP_VISIBLE_DEVICES", "")
    os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")
os.environ.setdefault("USE_TF", "0")  # the model card: TensorFlow probing can hang laya.load()

sys.path.insert(0, str(Path(__file__).resolve().parent))
import workflow_state  # noqa: E402  (same folder; compact state -> text)

CFG_DIR = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "hub-dashboard"
CONFIG = CFG_DIR / "laya.json"
DATA = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share")) / "hub-dashboard"
LABEL_FILES = [Path(__file__).resolve().parent.parent / "tools" / "seed.jsonl", CFG_DIR / "labels.jsonl"]
DEFAULTS = {"model": "vega", "port": 8770, "threads": 8, "device": "auto"}
MAX_TEXT = 4000
TOKEN_FILE = CFG_DIR / "laya-token"  # module-level so tests can point it elsewhere
MAX_MOVES = 24
MAX_EVENT = 80       # one compact state event / query string, capped before tokenizing (training and inference alike)
MAX_EVENTS_IN = 50   # array items accepted (to_text keeps the last 5)

# Workflow fit (module-level so tests can point them elsewhere)
WORKFLOW_FIT_DIR = DATA / "workflow-fit"
WORKFLOW_ROW_FILES = [DATA / "workflow_training_seed.jsonl", DATA / "workflow_mined.jsonl",
                      DATA / "workflow_labels.jsonl"]

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


# Workflow questions: asked by POST /workflow. Separate from QUESTIONS, whose hash keys the saved
# destination fit, so nothing here retrains /decide. Without a workflow fit they are answered
# zero-shot by the engine with next_move rebuilt per request from the enabled moves.
MOVE_CRITERIA = {
    "nav_shortcut_interceptor": "go straight to a site they keep reaching by typing a short name or a typo",
    "search_frustration_escalator": "ask an AI assistant, because they keep rephrasing the same web search",
    "canvas_study_bridge": "open study help for the Canvas course assignment they are working on",
    "creative_asset_router": "sort the images and design files they are collecting for a creative project",
}
NO_MOVE = "nothing to suggest; ordinary browsing"
SEQ_CRITERION = "repeat this recent sequence of sites"

WORKFLOW_QUESTIONS = {
    "should_stage": {
        "type": "noul",
        "instructions": "These are a person's last few browser events. Is there one obvious next step "
                        "worth getting ready for them right now?",
        "criteria": {"true": "yes, the events point to a clear next step",
                     "false": "no, this is ordinary browsing with no clear next step"},
    },
    "next_move": {
        "type": "choice",
        "instructions": "These are a person's last few browser events. Which shortcut would help them next?",
        "criteria": {**MOVE_CRITERIA, "none": NO_MOVE},  # rebuilt per request from the enabled moves
    },
}

# The fitted form. A head reads the features of the whole prompt, so the fitted question must be
# the same on every request: it always offers every seeded move, one generic label for all
# discovered seq_ moves, and "none". The reply is then narrowed to the moves the caller enabled.
# Own question ids, so the zero-shot questions above never meet a head fitted on other options.
FIT_NEXT, FIT_STAGE = "wf_next_move", "wf_should_stage"
SEQ_LABEL = "repeat_sequence"
LAYOUTS = ("single", "two")   # single: one next_move pass, should_stage derived; two: both asked
DEFAULT_LAYOUT = "single"
STAGE_YES, STAGE_NO = 0.6, 0.4


def fit_questions(layout=DEFAULT_LAYOUT):
    if layout not in LAYOUTS:
        raise ValueError(f"layout must be one of {LAYOUTS}")
    nxt = {"type": "choice", "instructions": WORKFLOW_QUESTIONS["next_move"]["instructions"],
           "criteria": {**MOVE_CRITERIA, SEQ_LABEL: SEQ_CRITERION, "none": NO_MOVE}}
    if layout == "single":
        return {FIT_NEXT: nxt}
    return {FIT_STAGE: json.loads(json.dumps(WORKFLOW_QUESTIONS["should_stage"])), FIT_NEXT: nxt}


def _move_criterion(move_id):
    if move_id in MOVE_CRITERIA:
        return MOVE_CRITERIA[move_id]
    if move_id.startswith("seq_"):
        hosts = [h.replace("-", ".") for h in move_id[4:].split("_") if h]
        return SEQ_CRITERION + (" (" + " then ".join(hosts) + ")" if hosts else "")
    return None


def _enabled(moves):
    """Valid enabled move ids, de-duplicated, at most MAX_MOVES, in the caller's order."""
    out = []
    for m in moves:
        if m != "none" and m not in out and _move_criterion(m):
            out.append(m)
        if len(out) >= MAX_MOVES:
            break
    return out


def workflow_questions(moves):
    """WORKFLOW_QUESTIONS with next_move limited to the given move ids plus "none"."""
    crit = {m: _move_criterion(m) for m in _enabled(moves)}
    qs = {k: dict(v) for k, v in WORKFLOW_QUESTIONS.items()}
    qs["next_move"]["criteria"] = {**crit, "none": NO_MOVE}
    return qs


def state_text(state):
    """The request's state as the text laya reads: a compact-state array (preferred) or old plain text."""
    if isinstance(state, list):
        items = [str(s).strip()[:workflow_state.MAX_HOST_PATH] for s in state[-MAX_EVENTS_IN:] if isinstance(s, (str, int, float))]
        items = [workflow_state.normalize_event(s)[:MAX_EVENT] for s in items if s]   # canvas ids first, then the cap
        return workflow_state.to_text(items)[:MAX_TEXT]
    if isinstance(state, str):
        return state.strip()[:MAX_TEXT]
    raise ValueError("state must be an array of strings or a string")


def fit_text(text, count, budget):
    """state_text output re-rendered with the oldest events dropped until count(text) <= budget (newest 2 kept)."""
    parts = text.split(" \u2192 ")
    if parts[-1].startswith("now: "):
        parts[-1] = parts[-1][5:]
    return workflow_state.to_text(workflow_state.trim_events(parts, count, budget))


def stage_from_p(p_yes, yes_at=STAGE_YES):
    if p_yes >= yes_at:
        return "yes", p_yes
    if p_yes <= STAGE_NO:
        return "no", 1 - p_yes
    return "unsure", max(p_yes, 1 - p_yes)


def _seq_hosts(move_id):
    return [h.replace("-", ".") for h in move_id[4:].split("_") if h]


def narrow_probs(raw, moves, state=""):
    """Fitted-question probabilities (over every seeded move, SEQ_LABEL, none) narrowed to the
    enabled moves plus "none" and renormalised. SEQ_LABEL goes to the enabled seq_ move whose sites
    best match the state (the first one on a tie); other seq_ moves get 0."""
    enabled = _enabled(moves)
    seqs = [m for m in enabled if m.startswith("seq_")]
    best_seq = None
    if seqs:
        low = state.lower()
        best_seq = max(seqs, key=lambda m: (sum(h in low or (h.endswith('.instructure.com') and 'canvas' in low) for h in _seq_hosts(m)), -seqs.index(m)))
    probs = {}
    for m in enabled:
        if m in MOVE_CRITERIA:
            probs[m] = float(raw.get(m, 0.0))
        else:
            probs[m] = float(raw.get(SEQ_LABEL, 0.0)) if m == best_seq else 0.0
    probs["none"] = float(raw.get("none", 0.0))
    tot = sum(probs.values())
    if tot <= 0:
        return {k: (1.0 if k == "none" else 0.0) for k in probs}
    return {k: round(v / tot, 4) for k, v in probs.items()}


# ----------------------------------------------------------------------------- workflow training
def _fit_label(move):
    if move == "none" or move in MOVE_CRITERIA:
        return move
    if isinstance(move, str) and move.startswith("seq_"):
        return SEQ_LABEL
    return None


RETIRED_MOVES = {"inline_unit_camera_calc"}  # core/calc.js answers these itself; Laya's label is "none"


def retire_move(r):
    """A row naming a retired move, as a "none" row (should_stage false); other rows unchanged."""
    if isinstance(r, dict) and r.get("next_move") in RETIRED_MOVES:
        return {**r, "next_move": "none", "should_stage": False}
    return r


def clean_rows(rows):
    """Contract rows ({state: [..], next_move, should_stage, ...}) that are usable, others dropped.
    Rows for a retired move (unit conversions) become "none"."""
    out = []
    for r in map(retire_move, rows):
        if not isinstance(r, dict) or not isinstance(r.get("should_stage"), bool):
            continue
        st = r.get("state")
        if not (isinstance(st, list) and st and all(isinstance(s, str) for s in st)) and not (isinstance(st, str) and st.strip()):
            continue
        if _fit_label(r.get("next_move")) is None:
            continue
        out.append({"state": workflow_state.normalize_state(st[-workflow_state.MAX_EVENTS:]) if isinstance(st, list) else st,
                    "next_move": r["next_move"], "should_stage": r["should_stage"],
                    **({"source": r["source"]} if r.get("source") else {})})
    return out


SOURCE_RANK = {"human": 3, "seed": 2, "auto_pos": 1, "auto_neg": 1}
FILE_SOURCE = {"workflow_training_seed.jsonl": "seed", "workflow_labels.jsonl": "human"}


def read_rows(paths):
    """Rows from JSONL files, one per state (last 5 events) as train_workflow_cli.py gathers them:
    human > seed > auto on a conflict, a later row winning a tie."""
    best = {}
    for p in paths:
        p = Path(p)
        if not p.exists():
            continue
        for line in p.read_text().splitlines():
            try:
                r = json.loads(line) if line.strip() else None
            except ValueError:
                continue
            if not isinstance(r, dict) or not isinstance(r.get("next_move"), str) or not isinstance(r.get("should_stage"), bool):
                continue
            r = retire_move(r)
            r = {**r, "source": FILE_SOURCE.get(p.name) or r.get("source", "auto_pos")}
            st = r.get("state")
            if isinstance(st, list):
                st = r["state"] = workflow_state.normalize_state([x for x in st if isinstance(x, str)] or [])
            key = tuple(workflow_state.normalize_state(st[-workflow_state.MAX_EVENTS:])) if isinstance(st, list) else st
            if not isinstance(key, (tuple, str)):
                continue
            old = best.get(key)
            if old is None or SOURCE_RANK.get(r["source"], 0) >= SOURCE_RANK.get(old["source"], 0):
                best[key] = r
    return clean_rows(list(best.values()))


def rows_to_gold(rows, layout=DEFAULT_LAYOUT):
    """Contract rows as laya fit rows. single: the move when should_stage, else "none";
    two: should_stage and next_move each as labelled."""
    gold = []
    for r in clean_rows(rows):
        text = state_text(r["state"])
        lab = _fit_label(r["next_move"])
        if layout == "single":
            gold.append({"state": text, "gold": {FIT_NEXT: lab if r["should_stage"] else "none"}})
        else:
            gold.append({"state": text, "gold": {FIT_STAGE: r["should_stage"], FIT_NEXT: lab}})
    return gold


def _sha(obj):
    return hashlib.sha256(json.dumps(obj, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def questions_hash(layout):
    return _sha({"layout": layout, "questions": fit_questions(layout)})


def workflow_fit_hash(rows, layout=DEFAULT_LAYOUT):
    """labels.sha256 of a workflow fit: the fitted questions plus the rows (order does not matter)."""
    lines = sorted(json.dumps(r, sort_keys=True, ensure_ascii=False) for r in clean_rows(rows))
    return _sha({"questions": questions_hash(layout), "rows": lines})


def resolve_device(want="auto"):
    """'cuda' when asked for (or on auto) and torch sees a GPU -- ROCm builds report through
    torch.cuda as well -- else 'cpu'."""
    want = str(want or "auto").strip().lower()
    if want == "cpu":
        return "cpu"
    try:
        import torch
        has_gpu = bool(torch.cuda.is_available())
    except Exception:
        has_gpu = False
    if want == "cuda" and not has_gpu:
        print("device: cuda asked for but torch sees no GPU; using cpu", file=sys.stderr, flush=True)
    return "cuda" if has_gpu else "cpu"


@contextlib.contextmanager
def _workflow_calibration(agent, cal):
    """Swap the workflow calibration in for one call; the destination one comes back after."""
    held, novelty = getattr(agent, "calibration", None), getattr(agent, "_novelty", None)
    agent.calibration = cal
    if hasattr(agent, "_novelty"):
        agent._novelty = None
    try:
        yield
    finally:
        agent.calibration = held
        if hasattr(agent, "_novelty"):
            agent._novelty = novelty


def _plan_fit(agent, qs, n, max_folds=5):
    """The most folds (max_folds down to 2) laya's floor allows for n rows, calibrated if possible."""
    min_rows = getattr(type(agent), "min_rows", None)
    if min_rows is None:
        return max_folds, True
    for calibrate in (True, False):
        for folds in (f for f in (5, 4, 3, 2) if f <= max_folds):
            if n >= min_rows(qs, folds, calibrate=calibrate):
                return folds, calibrate
    raise ValueError(f"too few workflow rows to fit: {n} (need {min_rows(qs, 2, calibrate=False)})")


def _private(path):
    try:
        os.chmod(path, 0o700 if Path(path).is_dir() else 0o600)
    except OSError:
        pass


def dedupe_rows(rows):
    """One row per state (last 5 events): the best source wins, a later row winning a tie."""
    best = {}
    for r in clean_rows(rows):
        st = r["state"]
        key = tuple(st) if isinstance(st, list) else st
        old = best.get(key)
        if old is None or SOURCE_RANK.get(r.get("source"), 0) >= SOURCE_RANK.get(old.get("source"), 0):
            best[key] = r
    return list(best.values())


def oversample(rows, times=2):
    """Human and seed rows `times` over, the rest once (training data only, never validation)."""
    return rows + [r for r in rows if r.get("source") in ("human", "seed")] * (times - 1)


def _row_label(r, layout=DEFAULT_LAYOUT):
    return _fit_label(r["next_move"]) if (layout != "single" or r["should_stage"]) else "none"


def _folds(rows, k, seed=0):
    """k folds over unique states, stratified by label: [(train_rows, val_rows)]."""
    import random
    rng, by = random.Random(seed), {}
    for r in rows:
        by.setdefault(_row_label(r), []).append(r)
    parts = [[] for _ in range(k)]
    i = 0
    for lab in sorted(by):
        grp = by[lab]
        rng.shuffle(grp)
        for r in grp:
            parts[i % k].append(r)
            i += 1
    return [([r for j, p in enumerate(parts) if j != f for r in p], parts[f]) for f in range(k)]


def cross_validate(agent, rows, qs, layout=DEFAULT_LAYOUT, k=5, seed=0):
    """Honest cross-validation of the workflow head. `rows` must already be one per state; each fold
    is fitted on its training states (human/seed oversampled 2x) and scored on its untouched
    validation states. Returns {accuracy, n, folds, oof: [{state, label, guess, p, source}]}."""
    k = max(2, min(k, len(rows)))
    oof = []
    for train, val in _folds(rows, k, seed):
        gold = rows_to_gold(oversample(train), layout)
        folds, calibrate = _plan_fit(agent, qs, len(gold))
        agent.fit(gold, questions=qs, folds=folds, calibrate=False)
        for r in val:
            out = agent.predict(state_text(r["state"]), qs)["answers"][FIT_NEXT]
            probs = out["probabilities"]
            guess = max(probs, key=probs.get)
            oof.append({"state": r["state"], "label": _row_label(r, layout), "guess": guess,
                        "p": round(float(probs[guess]), 4), "source": r.get("source")})
    acc = sum(o["label"] == o["guess"] for o in oof) / len(oof)
    return {"accuracy": round(acc, 4), "n": len(oof), "folds": k, "oof": oof}


def free_torch(device="cpu"):
    """Give a finished training model's memory back: gc, and the CUDA cache when cuda was used. Callers `del` their
    own references first."""
    import gc
    gc.collect()
    if str(device).startswith("cuda"):
        with contextlib.suppress(Exception):
            import torch
            torch.cuda.empty_cache()
    gc.collect()


def train_workflow(rows, device="auto", out_dir=None, layout=DEFAULT_LAYOUT, agent=None, threads=None, cv=True):
    """Fit the workflow head (see _train_workflow). An agent this call loaded itself is deleted and its memory
    freed before returning, so nothing holds the torch weights while hub-laya reloads."""
    own = []
    try:
        return _train_workflow(rows, device, out_dir, layout, agent, threads, cv, own)
    finally:
        dev = "cuda" if resolve_device(device) == "cuda" else "cpu"
        own.clear()
        free_torch(dev)


def _train_workflow(rows, device, out_dir, layout, agent, threads, cv, own):
    """Fit the workflow head on contract rows and save it (heads.npz, calibration.json,
    manifest.json, labels.sha256, fit_info.json, oof.json) to out_dir (default WORKFLOW_FIT_DIR).

    States are de-duplicated first. The reported CV accuracy is honest: folds are built over the
    unique states and the 2x human/seed oversampling is applied to each training fold only.
    The final fit uses all states, oversampled 2x.

    Loads its own vega unless `agent` is given; with one given, any destination fit already in
    it is left as it was. Returns {n, seconds, out_dir, layout, device, folds, calibrated, cv, report}."""
    rows = dedupe_rows(rows)
    gold = rows_to_gold(oversample(rows), layout)
    if not gold:
        raise ValueError("no usable workflow rows")
    out_dir = Path(out_dir or WORKFLOW_FIT_DIR)
    qs = fit_questions(layout)
    dev = resolve_device(device)
    if agent is None:
        import laya
        if dev == "cpu":
            import torch
            torch.set_num_threads(int(threads or load_config()["threads"]))
        agent = laya.Agent(vegaml=True, device=dev)
        own.append(agent)
    cv_rep = None
    if cv and layout == "single":
        cv_rep = cross_validate(agent, rows, qs, layout)
    folds, calibrate = _plan_fit(agent, qs, len(gold))
    t = time.perf_counter()
    held_cal, held_nov = getattr(agent, "calibration", None), getattr(agent, "_novelty", None)
    try:
        report = agent.fit(gold, questions=qs, folds=folds, calibrate=calibrate)
        wf_cal = agent.calibration if calibrate else None
        heads = agent.vega.heads
        keep = {q: v for q, v in heads.items() if q in qs}
        out_dir.mkdir(parents=True, exist_ok=True)
        _private(out_dir)
        agent.vega.heads, agent.calibration = keep, wf_cal   # save only the workflow heads
        try:
            agent.save_calibration(str(out_dir))
        finally:
            agent.vega.heads = heads
    finally:
        agent.calibration = held_cal
        if hasattr(agent, "_novelty"):
            agent._novelty = held_nov
    seconds = round(time.perf_counter() - t, 1)
    if not calibrate:
        with contextlib.suppress(FileNotFoundError):
            (out_dir / "calibration.json").unlink()  # a stale one from an earlier fit
    heads_rep = (report or {}).get("heads", {}) if isinstance(report, dict) else {}
    summary = {q: {k: r.get(k) for k in ("fitted", "examples", "cv_accuracy", "engine_accuracy", "used_by_auto", "reason")}
               for q, r in heads_rep.items()}
    info = {"layout": layout, "n": len(gold), "seconds": seconds, "device": dev, "folds": folds,
            "calibrated": calibrate, "questions_sha256": questions_hash(layout), "heads": summary,
            "n_unique": len(rows), "cv_accuracy": cv_rep and cv_rep["accuracy"], "t": int(time.time())}
    (out_dir / "fit_info.json").write_text(json.dumps(info, indent=1))
    if cv_rep:
        (out_dir / "oof.json").write_text(json.dumps(cv_rep["oof"]))
    (out_dir / "labels.sha256").write_text(workflow_fit_hash(rows, layout))
    for f in out_dir.iterdir():
        _private(f)
    return {"n": len(gold), "seconds": seconds, "out_dir": str(out_dir), "layout": layout, "device": dev,
            "folds": folds, "calibrated": calibrate, "n_unique": len(rows),
            "cv": cv_rep and {k: v for k, v in cv_rep.items() if k != "oof"}, "report": summary}


# ----------------------------------------------------------------------------- service
def read_token():
    """The shared secret for non-extension callers, or None when the file is missing or empty."""
    try:
        tok = TOKEN_FILE.read_text().strip()
    except OSError:
        return None
    return tok or None


def ensure_token():
    """Creates TOKEN_FILE (dir 700, file 600, 256 random bits) if missing or empty; returns the path.
    The value is never printed."""
    if read_token():
        return TOKEN_FILE
    import secrets
    TOKEN_FILE.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with contextlib.suppress(OSError):
        os.chmod(TOKEN_FILE.parent, 0o700)
    fd = os.open(TOKEN_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.fchmod(fd, 0o600)
        os.write(fd, (secrets.token_hex(32) + "\n").encode())
    finally:
        os.close(fd)
    return TOKEN_FILE


def load_config():
    cfg = dict(DEFAULTS)
    try:
        cfg.update(json.loads(CONFIG.read_text()))
    except FileNotFoundError:
        pass
    if __name__ == "__main__":  # the service: CPU unless LAYA_DEVICE=cuda opts in
        cfg["device"] = "cuda" if os.environ.get("LAYA_DEVICE", "").lower() == "cuda" else "cpu"
    return cfg


CACHE_MAX = 200


class WorkflowCache:
    """LRU of /workflow answers (max CACHE_MAX), keyed by the last 3 compact events joined with "|"
    plus the enabled move ids (they change the answer). Cleared when a workflow fit is (re)loaded."""

    def __init__(self, size=CACHE_MAX):
        self.size, self.d, self.lock = size, collections.OrderedDict(), threading.Lock()

    @staticmethod
    def key(state, moves):
        if not isinstance(state, list):
            return None
        tail = [str(s).strip()[:MAX_EVENT] for s in state if isinstance(s, (str, int, float))]
        tail = [s for s in tail if s][-3:]
        return "|".join(tail) + "#" + ",".join(sorted(moves)) if tail else None

    def get(self, k):
        with self.lock:
            v = self.d.get(k)
            if v is not None:
                self.d.move_to_end(k)
            return v

    def put(self, k, v):
        with self.lock:
            self.d[k] = v
            self.d.move_to_end(k)
            while len(self.d) > self.size:
                self.d.popitem(last=False)

    def clear(self):
        with self.lock:
            self.d.clear()


class Model:
    def __init__(self, name, threads=8, device="auto", ov=None):
        self.name = name
        # OpenVINO reader (laya_ov.py): on for the service, or when LAYA_INFER_DEVICE is set; training keeps torch
        self.use_ov = bool(os.environ.get("LAYA_INFER_DEVICE")) if ov is None else bool(ov)
        self.ov_device = None   # "npu" | "gpu" | "cpu-ov" while the OpenVINO reader is in use
        self.ov_note = None     # why it is not in use
        self.threads = threads
        self.device_pref = device
        self.device = None
        self.agent = None
        self.error = None
        self.lock = threading.Lock()
        self.wf = None        # {"layout", "n", "stale", ...} once a workflow fit is loaded
        self.wf_cal = None
        self.cache = WorkflowCache()

    @property
    def infer_device(self):
        """Where live /workflow inference really runs: "npu", "gpu" or "cpu-ov" when the OpenVINO reader
        (laya_ov.py) is active, else the torch device ("cuda" or "cpu"). LAYA_INFER_DEVICE=npu|gpu|cpu-ov|cpu
        overrides the automatic pick (the fastest device that passed parity, low-power ones preferred)."""
        if self.ov_device:
            import laya_ov
            if not laya_ov.FAILED:
                return self.ov_device
        return self.device or "cpu"

    def _try_ov(self, dev):
        """Switch vegaml's reader to the OpenVINO IR before it loads (so torch never holds a second copy)."""
        self.ov_device = None
        if not self.use_ov or dev != "cpu":
            return
        want = os.environ.get("LAYA_INFER_DEVICE", "auto")
        try:
            import laya_ov
            name, why = laya_ov.activate(want)
        except Exception as e:
            name, why = None, f"{type(e).__name__}: {e}"
        self.ov_device, self.ov_note = name, why
        if why:
            print(f"openvino reader not used: {why}", flush=True)

    @staticmethod
    def _restore_torch_reader():
        import vegaml._api as api
        import vegaml._common as common
        api.Perception = common.Perception

    def load(self):
        try:
            import laya
            dev = resolve_device(self.device_pref)
            if dev == "cpu":
                import torch
                torch.set_num_threads(int(self.threads))
            t = time.perf_counter()
            self._try_ov(dev)
            try:
                agent = self._load_agent(laya, dev)
            except Exception as e:
                if not self.ov_device:
                    raise
                print(f"WARNING: openvino reader failed to load or compile ({type(e).__name__}: {e}); using torch", file=sys.stderr, flush=True)
                self.ov_note, self.ov_device = f"{type(e).__name__}: {e}", None
                self._restore_torch_reader()
                self.cache.clear()
                agent = self._load_agent(laya, dev)
            self.device = str(getattr(agent, "device", None) or dev)
            self.agent = agent  # only now does /health say ready
            print(f"laya ready: {self.name} on {self.infer_device} in {time.perf_counter() - t:.1f}s", flush=True)
        except Exception as e:
            self.error = f"{type(e).__name__}: {e}"
            print("laya failed to load:", self.error, file=sys.stderr, flush=True)

    def _load_agent(self, laya, dev):
        if self.name == "vega":
            agent = laya.Agent(vegaml=True, device=dev)
            self._train(agent)
            self.load_workflow(agent)
        else:
            agent = laya.load(self.name, device=dev)
        agent.predict("warm up", QUESTIONS)  # first call builds caches (and proves the OpenVINO reader runs)
        return agent

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

    def load_workflow(self, agent, fit_dir=None):
        """Adds a saved workflow fit's heads to `agent` and keeps its calibration aside.
        Loaded when labels.sha256 matches the questions plus the row files on disk; a fit whose
        questions match but whose rows have changed since is still loaded and reported stale
        (rerun --train-workflow). Returns self.wf or None."""
        self.cache.clear()  # old answers belong to the old fit
        d = Path(fit_dir or WORKFLOW_FIT_DIR)
        try:
            info = json.loads((d / "fit_info.json").read_text())
            stamp = (d / "labels.sha256").read_text().strip()
        except (OSError, ValueError):
            return None
        layout = info.get("layout")
        if layout not in LAYOUTS or info.get("questions_sha256") != questions_hash(layout):
            print("workflow fit ignored: its questions differ from this version", flush=True)
            return None
        stale = stamp != workflow_fit_hash(read_rows(WORKFLOW_ROW_FILES), layout)
        try:
            with _workflow_calibration(agent, None):
                out = agent.load_calibration(str(d))
                cal = agent.calibration
        except Exception as e:
            print("workflow fit failed to load:", type(e).__name__, e, file=sys.stderr, flush=True)
            return None
        if not set(fit_questions(layout)) <= set(out.get("heads") or []):
            print("workflow fit has no head for every question; ignored", flush=True)
            return None
        self.cache.clear()
        self.wf_cal = cal
        self.wf = {"layout": layout, "n": info.get("n"), "stale": stale, "t": info.get("t")}
        print(f"loaded workflow fit ({layout}, {info.get('n')} rows{', stale' if stale else ''})", flush=True)
        return self.wf

    def workflow(self, state, moves, key=None):
        """Answer for `state` (text). With `key` (see WorkflowCache.key) a repeat is served from the LRU."""
        hit = key and self.cache.get(key)
        if hit:
            return {**hit, "ms": 0.0, "cached": True}
        out = self._workflow(state, moves)
        if out.get("ok"):
            out["infer_device"] = self.infer_device
            out["fit"] = (self.wf or {}).get("t")  # the extension drops its own cache when this changes
        if key and out.get("ok"):
            self.cache.put(key, out)
        return out

    def fit_state(self, state, qs):
        """`state` (text from state_text) cut to what the static OpenVINO graph can read: while the prompt would
        exceed its token length drop the oldest events (keeping the newest 2, and the "now: " prefix). If 2 events
        still don't fit the reader clips tokens (laya_ov.clip_item). Never touches torch."""
        try:
            import laya_ov
            if not (self.ov_device and laya_ov.OV_READER) or " \u2192 " not in state:
                return state
            tok = laya_ov.tokenizer()
            budget = laya_ov.state_budget(tok, qs, laya_ov.OV_READER.max_len)
            return fit_text(state, lambda t: len(tok(t, add_special_tokens=False)["input_ids"]), budget)
        except Exception as e:
            print("fit_state skipped:", type(e).__name__, file=sys.stderr, flush=True)
            return state

    def _workflow(self, state, moves):
        if self.wf:
            return self._workflow_fitted(state, moves)
        qs = workflow_questions(moves)
        t = time.perf_counter()
        try:
            with self.lock:
                out = self.agent.predict(self.fit_state(state, qs), qs)
            stage = out["answers"]["should_stage"]
            nxt = out["answers"]["next_move"]
            p_yes = float(stage.get("noul", stage.get("probabilities", {}).get("true", 0.0)))
            probs = {k: round(float(v), 4) for k, v in nxt["probabilities"].items()}
        except Exception as e:  # e.g. an engine that only answers questions it was fitted on
            print("workflow failed:", type(e).__name__, file=sys.stderr, flush=True)
            return {"ok": False, "error": "workflow questions not trained"}
        stage_choice, stage_p = stage_from_p(p_yes)
        best = max(probs, key=probs.get) if probs else "none"
        return {"ok": True,
                "should_stage": {"choice": stage_choice, "p": round(stage_p, 4), "route": stage.get("route")},
                "next_move": {"choice": best, "p": probs.get(best, 0.0), "probs": probs, "route": nxt.get("route")},
                "ms": round((time.perf_counter() - t) * 1000, 1)}

    def _workflow_fitted(self, state, moves):
        layout = self.wf["layout"]
        qs = fit_questions(layout)
        t = time.perf_counter()
        try:
            with self.lock, _workflow_calibration(self.agent, self.wf_cal):
                out = self.agent.predict(self.fit_state(state, qs), qs)
            nxt = out["answers"][FIT_NEXT]
            probs = narrow_probs(nxt["probabilities"], moves, state)
            if layout == "two":
                stage = out["answers"][FIT_STAGE]
                p_yes = float(stage.get("noul", stage.get("probabilities", {}).get("true", 0.0)))
                stage_route = stage.get("route")
            else:  # single pass: stage when the chosen move isn't "none"
                p_yes, stage_route = 1.0 - probs["none"], nxt.get("route")
        except Exception as e:
            print("workflow failed:", type(e).__name__, file=sys.stderr, flush=True)
            return {"ok": False, "error": "workflow fit failed"}
        # single pass: "yes" as soon as a move beats "none" (p_yes > 0.5); the extension still needs next_move.p >= its threshold
        stage_choice, stage_p = stage_from_p(p_yes, 0.5 if layout != "two" else STAGE_YES)
        best = max(probs, key=probs.get)
        return {"ok": True,
                "should_stage": {"choice": stage_choice, "p": round(stage_p, 4), "route": stage_route},
                "next_move": {"choice": best, "p": probs[best], "probs": probs, "route": nxt.get("route")},
                "ms": round((time.perf_counter() - t) * 1000, 1)}

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
                wf = dict(model.wf, fitted=True) if model.wf else {"fitted": False}
                return self._reply(200, {"ok": model.error is None, "model": model.name,
                                         "ready": model.agent is not None, "error": model.error,
                                         "device": model.device, "infer_device": model.infer_device, "workflow": wf})
            self._reply(404, {"ok": False, "error": "not found"})

        def _workflow_allowed(self):
            if self.headers.get("Host") not in hosts:
                return False
            if self.headers.get("Origin", "").startswith("moz-extension://"):
                return True
            tok, sent = read_token(), self.headers.get("X-Hub-Token", "")
            return bool(tok and sent) and hmac.compare_digest(sent.encode(), tok.encode())

        def _workflow(self):
            if not self._workflow_allowed():
                return self._reply(403, {"ok": False, "error": "forbidden"})
            try:
                n = int(self.headers.get("Content-Length", "0"))
                if n > 64_000:
                    return self._reply(413, {"ok": False, "error": "too long"})
                body = json.loads(self.rfile.read(n) or b"{}")
                raw = body.get("state", "")
                state = state_text(raw)
                moves = body.get("moves") or []
                if not isinstance(moves, list):
                    raise ValueError
                moves = [m for m in moves if isinstance(m, str) and 0 < len(m) <= 200][:MAX_MOVES * 2]
            except Exception:
                return self._reply(400, {"ok": False, "error": "bad request"})
            if not state:
                return self._reply(400, {"ok": False, "error": "empty state"})
            if model.agent is None:
                return self._reply(503, {"ok": False, "error": model.error or "still loading"})
            out = model.workflow(state, moves, WorkflowCache.key(raw, moves))
            self._reply(200 if out["ok"] else 503, out)

        def do_POST(self):
            if self.path == "/workflow":
                return self._workflow()
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
    args = sys.argv[1:]
    if args[:1] == ["--train-workflow"]:  # laya_server.py --train-workflow rows.jsonl ...
        files = args[1:] or [str(p) for p in WORKFLOW_ROW_FILES]
        out = train_workflow(read_rows(files), device=cfg["device"], threads=cfg["threads"],
                             layout=cfg.get("workflow_layout", DEFAULT_LAYOUT))
        print(json.dumps(out, indent=1))
        if os.environ.get("LAYA_OV_AUTOEXPORT", "1") != "0":
            import laya_ov
            laya_ov.ensure_export()  # no-op unless the IR is missing or stale; capped child processes
        return
    if args:  # quick test: laya_server.py "some text"
        m = Model(cfg["model"], cfg["threads"], cfg["device"])
        m.load()
        for text in args:
            print(json.dumps({"text": text, **m.decide(text)}))
        return
    ensure_token()
    model = Model(cfg["model"], cfg["threads"], cfg["device"], ov=True)
    threading.Thread(target=model.load, daemon=True).start()
    port = int(cfg["port"])
    server = ThreadingHTTPServer(("127.0.0.1", port), make_handler(model, port))
    print(f"listening on http://127.0.0.1:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
