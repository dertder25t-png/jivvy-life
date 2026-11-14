#!/usr/bin/env python3
"""Lifeboard pattern miner: finds your repeated browsing habits in Firefox history.

Runs nightly (hub-miner.timer) or from the drawer's "Scan now". It copies places.sqlite
(and its -wal) into a private temp folder, reads the copy, and deletes it again. Firefox's
own file is never opened. Over the last 60 days it finds:
  (a) nav aliases: a short search followed within 60 s by a visit to a site, 2+ times
  (b) 3-site sequences inside 10 minutes, 4+ times on 3+ days (laya may veto them)
  (c) how often each of the 5 seeded moves would have helped
and writes ~/.local/share/hub-dashboard/discovered_moves.json (mode 600, folder 700).

  pattern_miner.py [--days N] [--profile DIR] [--out FILE] [--print]
  pattern_miner.py --seed intent.json [--out FILE] [--print]   -> seed_local.json

--seed reads a JSON list of what you type to get somewhere and keeps only the targets
that really are in your history. --print shows counts only (never raw searches).
Shapes: docs/predictive-moves-contract.md. Python standard library only.
"""
import argparse
import configparser
import json
import os
import re
import shutil
import sqlite3
import sys
import tempfile
import time
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

HOME = Path.home()
DATA = Path(os.environ.get("XDG_DATA_HOME", HOME / ".local/share")) / "hub-dashboard"
TOKEN = Path(os.environ.get("XDG_CONFIG_HOME", HOME / ".config")) / "hub-dashboard" / "laya-token"
LAYA_URL = "http://127.0.0.1:8770/workflow"
PROFILE_BASES = [HOME / "snap/firefox/common/.mozilla/firefox", HOME / ".mozilla/firefox"]

# Sign-in pages sit between the pages you meant to visit. Dropped before anything is
# counted, so A -> login -> B counts as A -> B.
IGNORE_SSO_HOSTS = {"login.microsoftonline.com", "sso.canvaslms.com", "accounts.google.com",
                    "accounts.firefox.com", "auth.openai.com"}
IGNORE_SSO_SUFFIXES = (".cloudflareaccess.com",)
IGNORE_SSO_PATHS = ("/oauth", "/saml", "/sso", "/cdn-cgi/access/")

ASSET_HOSTS = ("pinterest.com", "pexels.com", "pixabay.com", "magnific.com", "unsplash.com",
               "freepik.com", "stock.adobe.com")
UNIT_RE = re.compile(r"\d[\d.,]*\s*(k|m|g|t)?i?b\b|\d\s*(kg|lbs?|oz|grams?|mah|wh|mbps|gbps)\b"
                     r"|\bx-?t4\b.*\b(record|minutes|hours)", re.I)

# What a typed site name usually means. Used for --seed only, and only if that site is in
# your history. A match is a host test: "=x" exact (after www.), ".x" suffix, "x." prefix, "~x" substring.
KNOWN_TARGETS = {
    "eagles nest": "~eaglesnest", "google drive": "=drive.google.com", "drive": "=drive.google.com",
    "google docs": "=docs.google.com", "calendar": "=calendar.google.com",
    "cloudflare": "=dash.cloudflare.com", "claudflare": "=dash.cloudflare.com",
    "pinterest": ".pinterest.com", "pintrest": ".pinterest.com", "pintr": ".pinterest.com",
    "canvas": ".instructure.com", "google messages": "=messages.google.com",
    "keep": "=keep.google.com", "google keep": "=keep.google.com", "outlook": "outlook.",
    "vercel": ".vercel.com", "github": ".github.com", "claude": ".claude.ai",
    "gemini": "=gemini.google.com", "chatgpt": ".chatgpt.com",
}
COURSE_EXTS = [(re.compile(r"photograph", re.I), ["tif", "jpg", "png"]),
               (re.compile(r"publication|design", re.I), ["pdf", "indd", "idml"]),
               (re.compile(r"media", re.I), ["pdf", "mp4", "mov"])]
DEFAULT_EXTS = ["pdf", "jpg", "png"]


# ---- reading history ---------------------------------------------------------------

def find_profile():
    """The default profile: the [Install...] Default=, else Default=1, else the first one."""
    for base in PROFILE_BASES:
        ini = configparser.ConfigParser(interpolation=None)
        try:
            if not ini.read(base / "profiles.ini"):
                continue
        except configparser.Error:
            continue
        picks = [ini[s]["Default"] for s in ini.sections() if s.startswith("Install") and ini[s].get("Default")]
        profiles = [ini[s] for s in ini.sections() if s.startswith("Profile") and ini[s].get("Path")]
        profiles.sort(key=lambda p: p.get("Default") != "1")
        for p in profiles:
            picks.append(p["Path"] if p.get("IsRelative", "1") == "1" else str(Path(p["Path"])))
        for rel in picks:
            path = base / rel  # an absolute rel replaces base
            if (path / "places.sqlite").is_file():
                return path
    return None


def load_visits(profile, days, now):
    """[(t seconds, url, title)] since `days` ago, oldest first, from a private copy."""
    tmp = tempfile.mkdtemp(prefix="hub-miner-")  # mode 700
    try:
        for name in ("places.sqlite", "places.sqlite-wal"):
            if (Path(profile) / name).is_file():
                shutil.copyfile(Path(profile) / name, Path(tmp) / name)
        db = sqlite3.connect(f"file:{Path(tmp) / 'places.sqlite'}?mode=ro", uri=True)
        try:
            rows = db.execute(
                "SELECT v.visit_date, p.url, p.title FROM moz_historyvisits v "
                "JOIN moz_places p ON p.id = v.place_id "
                "WHERE v.visit_date >= ? AND v.visit_type != 9 "  # 9 = reload
                "ORDER BY v.visit_date", (int((now - days * 86400) * 1e6),)).fetchall()
        finally:
            db.close()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return [(d / 1e6, u, t) for d, u, t in rows if isinstance(u, str)]


def host_of(netloc):
    host = netloc.lower().rsplit("@", 1)[-1].split(":", 1)[0]
    return host[4:] if host.startswith("www.") else host


def is_sso(host, path):
    p = path.lower()
    return (host in IGNORE_SSO_HOSTS or host.endswith(IGNORE_SSO_SUFFIXES)
            or any(s in p for s in IGNORE_SSO_PATHS))


def is_engine(host):
    return host.startswith("google.") or host in ("duckduckgo.com", "bing.com")


def search_query(host, path, query):
    """The text of a Google / DuckDuckGo / Bing search, else None."""
    if (host.startswith("google.") and path == "/search") or host == "duckduckgo.com" \
            or (host == "bing.com" and path == "/search"):
        q = parse_qs(query).get("q")
        if q and q[0].strip():
            return " ".join(q[0].lower().split())[:200]
    return None


def events_from(visits):
    """Visits as dicts, with sign-in pages and non-web URLs removed."""
    out = []
    for t, url, title in visits:
        try:
            u = urlsplit(url)
        except ValueError:
            continue
        if u.scheme not in ("http", "https") or not u.netloc:
            continue
        host = host_of(u.netloc)
        if is_sso(host, u.path):
            continue
        out.append({"t": t, "url": url, "host": host, "path": u.path or "/", "origin": f"{u.scheme}://{u.netloc.lower()}/",
                    "title": title or "", "q": search_query(host, u.path, u.query), "query": u.query})
    return out


def split_sessions(events, gap=600):
    """Lists of events, a new one whenever more than `gap` seconds pass between visits."""
    sessions = []
    for e in events:
        if not sessions or e["t"] - sessions[-1][-1]["t"] > gap:
            sessions.append([])
        sessions[-1].append(e)
    return sessions


# ---- mining --------------------------------------------------------------------------

def origins_by_host(events):
    c = defaultdict(Counter)
    for e in events:
        c[e["host"]][e["origin"]] += 1
    return {h: o.most_common(1)[0][0] for h, o in c.items()}


GENERIC_LABELS = {"www", "com", "org", "net", "edu", "gov", "io", "co", "app", "ai", "dev", "google", "the"}


def names_host(q, host):
    """True if the search looks like the site's name ("google dive" -> drive.google.com,
    "egales nest" -> eaglesnest.school.edu), or the known-site table says so ("canvas")."""
    labels = [l for l in re.split(r"[.-]", host) if len(l) >= 3 and l not in GENERIC_LABELS]
    words = [w for w in re.split(r"[^a-z0-9]+", q) if len(w) >= 3 and w not in GENERIC_LABELS]
    squashed = "".join(words)
    for w in words + ([squashed] if len(words) > 1 else []):
        for l in labels:
            if edit_distance(w, l) <= (1 if min(len(w), len(l)) <= 5 else 2) or (len(w) >= 4 and w in l):
                return True
    rule = known_rule(q)
    return bool(rule and host_matches(host, rule))


def mine_aliases(events, origin):
    """{query: url} for short searches that named a site and led to it 2+ times within 60 s."""
    pairs = Counter()
    for i, e in enumerate(events):
        q = e["q"]
        if not q or len(q) > 40 or len(q.split()) > 4:
            continue
        for f in events[i + 1:]:
            if f["t"] - e["t"] > 60:
                break
            if not is_engine(f["host"]):
                if names_host(q, f["host"]):
                    pairs[(q, f["host"])] += 1
                break
    best = {}
    for (q, host), n in pairs.items():
        if n >= 2 and n > best.get(q, (None, 0))[1]:
            best[q] = (host, n)
    return {q: origin[h] for q, (h, _n) in best.items()}, sum(n for _h, n in best.values())


# Canvas names course pages "Course Modules: ART 101: Photography II" (section: code: course).
# Assignment titles are skipped: they can end in the student's own name.
COURSE_TITLE = re.compile(r"^[^:]+:\s*[A-Z]{2,5}\s?\d{2,4}[A-Z0-9-]*\s*:\s*(.+)$")


def course_name(path, title):
    m = COURSE_TITLE.match(title.strip())
    if m:
        return re.sub(r"\s+", " ", m.group(1)).strip()[:80], 2
    if re.fullmatch(r"/courses/\d+/?", path) and title.strip() and title.strip() != "Canvas LMS":
        return re.sub(r"\s+", " ", title.split(":")[-1]).strip()[:80], 1  # the course home page
    return None, 0


def mine_courses(events):
    """{course id: {name, exts}} from <school>.instructure.com/courses/<id> page titles."""
    titles = defaultdict(Counter)
    for e in events:
        m = re.match(r"/courses/(\d+)", e["path"])
        if m and e["host"].endswith(".instructure.com"):
            name, weight = course_name(e["path"], e["title"])
            if name:
                titles[m.group(1)][name] += weight
    courses = {}
    for cid, c in titles.items():
        name = c.most_common(1)[0][0]
        exts = next((x for rx, x in COURSE_EXTS if rx.search(name)), DEFAULT_EXTS)
        courses[cid] = {"name": name, "exts": list(exts)}
    return courses


def mine_sequences(events):
    """3 different sites in a row within 10 min, 4+ times on 3+ days (searches skipped)."""
    seq = []
    for e in events:
        if is_engine(e["host"]):
            continue
        if seq and seq[-1]["host"] == e["host"]:
            continue
        seq.append(e)
    n, days = Counter(), defaultdict(set)
    for a, b, c in zip(seq, seq[1:], seq[2:]):
        hosts = (a["host"], b["host"], c["host"])
        if len(set(hosts)) == 3 and c["t"] - a["t"] <= 600:
            n[hosts] += 1
            days[hosts].add(time.strftime("%Y-%m-%d", time.localtime(a["t"])))
    return [(h, k, len(days[h])) for h, k in n.most_common() if k >= 4 and len(days[h]) >= 3][:20]


def jaccard(a, b):
    a, b = set(a.split()), set(b.split())
    return len(a & b) / len(a | b) if a | b else 0.0


def mine_counts(events, alias_hits, n_aliases):
    searches = [e for e in events if e["q"]]
    google = [e for e in searches if e["host"].startswith("google.")]
    frustration = sum(1 for x, y in zip(google, google[1:])
                      if y["t"] - x["t"] <= 45 and x["q"] != y["q"] and jaccard(x["q"], y["q"]) > 0.55)
    canvas = sum(1 for e in events if e["host"].endswith(".instructure.com")
                 and re.match(r"/courses/\d+/assignments/\d+", e["path"]))
    asset = [e["t"] for e in events if e["host"].endswith(ASSET_HOSTS)
             and ("search" in e["path"].lower() or "q=" in e["query"])]
    bursts, i = 0, 0
    while i + 2 < len(asset):
        if asset[i + 2] - asset[i] <= 300:
            bursts += 1
            start = asset[i]
            while i < len(asset) and asset[i] - start <= 3600:  # one 60-min harvest window
                i += 1
        else:
            i += 1
    calc = sum(1 for e in searches if UNIT_RE.search(e["q"]))
    return {
        "nav_shortcut_interceptor": {"n": alias_hits, "note": f"{alias_hits} searches were just a site name ({n_aliases} shortcuts)"},
        "search_frustration_escalator": {"n": frustration, "note": f"{frustration} times you re-searched almost the same thing within 45 s"},
        "canvas_study_bridge": {"n": canvas, "note": f"{canvas} Canvas assignment visits"},
        "creative_asset_router": {"n": bursts, "note": f"{bursts} bursts of image or stock searches"},
        "inline_unit_camera_calc": {"n": calc, "note": f"{calc} unit-conversion searches"},
    }


def ask_laya(hosts, token, state):
    """laya's {should_stage, p} for staging the third site, or None if it can't answer."""
    if not token or state.get("down"):
        return None
    body = json.dumps({"state": f"Visited {hosts[0]}, then {hosts[1]}. Next might be {hosts[2]}.",
                       "moves": [seq_id(hosts)]}).encode()
    req = urllib.request.Request(LAYA_URL, data=body, method="POST",
                                 headers={"Content-Type": "application/json", "X-Hub-Token": token})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            reply = json.loads(r.read())
        s = reply.get("should_stage") if reply.get("ok") else None
        return {"should_stage": s["choice"], "p": float(s["p"])} if isinstance(s, dict) else None
    except Exception:
        state["down"] = True  # not running, or no /workflow yet: stop asking
        return None


def seq_id(hosts):
    return "seq_" + "_".join(h.replace(".", "-") for h in hosts)


def mine_all(events, use_laya=True):
    origin = origins_by_host(events)
    aliases, alias_hits = mine_aliases(events, origin)
    token = None
    if use_laya:
        try:
            token = TOKEN.read_text().strip() or None
        except OSError:
            pass
    state, found = {}, []
    for hosts, n, days in mine_sequences(events):
        laya = ask_laya(hosts, token, state)
        if laya and not (laya["should_stage"] == "yes" and laya["p"] >= 0.85):
            continue
        found.append({"id": seq_id(hosts), "hosts": list(hosts), "n": n, "days": days,
                      "label": f"After {hosts[0]} and {hosts[1]}, open {hosts[2]}",
                      "url": origin[hosts[2]], "laya": laya})
    return {"t": int(time.time() * 1000), "navAliases": aliases, "canvasCourses": mine_courses(events),
            "counts": mine_counts(events, alias_hits, len(aliases)), "discovered": found}


# ---- --seed --------------------------------------------------------------------------

def edit_distance(a, b):
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def host_matches(host, rule):
    kind, x = rule[0], rule[1:]
    if kind == "=":
        return host == x
    if kind == ".":  # the domain itself or any subdomain
        return host == x or host.endswith(rule)
    if kind == "~":
        return x in host
    return host.startswith(rule)  # "outlook." prefix


def known_rule(variant):
    if variant in KNOWN_TARGETS:
        return KNOWN_TARGETS[variant]
    close = [(edit_distance(variant, k), k) for k in KNOWN_TARGETS if len(k) > 5]
    close = [c for c in close if c[0] <= 2]
    return KNOWN_TARGETS[min(close)[1]] if close else None


def seed(intent, events):
    """seed_local.json from the intent file, keeping only targets found in history."""
    origin = origins_by_host(events)
    visits = Counter(e["host"] for e in events)
    mined, _ = mine_aliases(events, origin)
    aliases, unmatched = {}, []
    typed = intent.get("frequent_navigation_shortcuts_typed_as_searches") if isinstance(intent, dict) else None
    for entry in typed if isinstance(typed, list) else []:
        if not isinstance(entry, str):
            continue
        text = re.sub(r"\(\s*\d+\s*x\s*\)", "", entry).lower()
        variants = [" ".join(v.split()) for v in text.split("/") if v.strip()][:10]
        url = next((mined[v] for v in variants if v in mined), None)
        if not url:
            rule = next((r for r in map(known_rule, variants) if r), None)
            hosts = [h for h, _n in visits.most_common() if rule and host_matches(h, rule)]
            url = origin[hosts[0]] if hosts else None
        if url:
            for v in variants:
                aliases[v[:60]] = url
        else:
            unmatched.append(entry.strip()[:120])
    out = {"t": int(time.time() * 1000), "navAliases": aliases, "canvasCourses": mine_courses(events),
           "unmatched": unmatched}
    user = (intent.get("profile") or {}).get("user") if isinstance(intent, dict) else None
    if isinstance(user, str) and user.split():
        out["name"] = re.sub(r"[^\w'-]", "", user.split()[0])[:40]
    return out


# ---- output --------------------------------------------------------------------------

def write_private(path, obj):
    """JSON as mode 600 in a 700 folder, replaced in one step."""
    write_private_text(path, json.dumps(obj, indent=1))


def write_private_text(path, text):
    """Text as mode 600 in a 700 folder, replaced in one step."""
    path = Path(path)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.parent == DATA:
        os.chmod(path.parent, 0o700)
    tmp = path.with_name(f".{path.name}.{os.getpid()}")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


def summary(out):
    """Counts only. Alias keys are the one piece of typed text shown."""
    lines = [f"nav aliases: {len(out['navAliases'])}  ({', '.join(sorted(out['navAliases']))})",
             f"canvas courses: {len(out['canvasCourses'])}"]
    for cid, c in sorted(out["canvasCourses"].items()):
        lines.append(f"  {cid}: {c['name']} -> {','.join(c['exts'])}")
    if "unmatched" in out:
        lines.append(f"unmatched: {len(out['unmatched'])}  ({'; '.join(out['unmatched'])})")
        if out.get("name"):
            lines.append(f"name: {out['name']}")
    if "discovered" in out:
        lines.append(f"discovered sequences: {len(out['discovered'])}")
        for d in out["discovered"]:
            lines.append(f"  {' -> '.join(d['hosts'])}  {d['n']}x on {d['days']} days  laya={d['laya']}")
        for move, c in out["counts"].items():
            lines.append(f"{move}: {c['n']}  ({c['note']})")
    return "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Mine Firefox history for Lifeboard's predictive moves.")
    ap.add_argument("--days", type=int, default=60)
    ap.add_argument("--profile", help="Firefox profile folder (default: found via profiles.ini)")
    ap.add_argument("--out", help="output file (default: ~/.local/share/hub-dashboard/...)")
    ap.add_argument("--seed", metavar="INTENT_JSON", help="write seed_local.json from this file")
    ap.add_argument("--print", action="store_true", help="print a summary (counts only)")
    ap.add_argument("--no-laya", action="store_true", help="don't ask laya about sequences")
    a = ap.parse_args(argv)

    profile = Path(a.profile) if a.profile else find_profile()
    if not profile or not (profile / "places.sqlite").is_file():
        print("No Firefox profile with places.sqlite found (use --profile).", file=sys.stderr)
        return 1
    events = events_from(load_visits(profile, max(1, min(a.days, 365)), time.time()))
    if a.seed:
        with open(a.seed, encoding="utf-8") as f:
            intent = json.load(f)  # untrusted data: only read as plain JSON values
        out, target = seed(intent, events), a.out or DATA / "seed_local.json"
    else:
        out, target = mine_all(events, not a.no_laya), a.out or DATA / "discovered_moves.json"
    write_private(target, out)
    if a.print:
        print(summary(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
