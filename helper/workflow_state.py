"""Compact workflow state: short strings laya reads fast (see docs/predictive-moves-contract.md).

  visit     host/path                 e.g. school.instructure.com/courses/123/assignments/456
  search    <engine>:q=<query>        e.g. google:q=1.43 kg to lb
  download  dl:<basename>             e.g. dl:proof.pdf

The extension has a twin (compactEvent in extension/core/moves.js); tests/workflow_state_vectors.json keeps them identical.
"""
import re
from urllib.parse import parse_qs, unquote_plus, urlsplit

MAX_PATH, MAX_QUERY, MAX_NAME, MAX_EVENTS = 40, 60, 40, 5
MAX_HOST_PATH = 200

# host suffix -> (engine, how to find the query): ("param", name) or ("path", segment after this prefix)
ENGINES = [
    ("google.", "google", ("param", "q")),
    ("duckduckgo.com", "duckduckgo", ("param", "q")),
    ("bing.com", "bing", ("param", "q")),
    ("pinterest.", "pinterest", ("param", "q")),
    ("pexels.com", "pexels", ("path", "/search/")),
    ("pixabay.com", "pixabay", ("param", "q")),
    ("unsplash.com", "unsplash", ("path", "/s/photos/")),
    ("freepik.com", "freepik", ("param", "query")),
    ("magnific.", "magnific", ("param", "q")),
    ("dreamstime.com", "dreamstime", ("param", "srh_field")),
    ("shutterstock.com", "shutterstock", ("path", "/search/")),
    ("vecteezy.com", "vecteezy", ("param", "qterm")),
    ("freerangestock.com", "freerangestock", ("param", "q")),
]


def _host(netloc):
    h = netloc.lower().split("@")[-1].split(":")[0]
    return h[4:] if h.startswith("www.") else h


def _clean_query(q):
    return " ".join(q.lower().split())[:MAX_QUERY]


def search_of(url):
    """(engine, query) for a search-results URL, else None."""
    try:
        u = urlsplit(url)
    except ValueError:
        return None
    host = _host(u.netloc)
    for frag, engine, (kind, key) in ENGINES:
        if not (host.startswith(frag) or ("." + frag) in ("." + host) or host.endswith(frag)):
            continue
        if kind == "param":
            if engine in ("google", "bing", "duckduckgo") and not (u.path in ("/search", "/", "/html/") or u.path.startswith("/search")):
                return None
            vals = parse_qs(u.query).get(key)
            q = vals[0] if vals else ""
            if not q and engine == "pixabay" and "/search/" in u.path:
                q = unquote_plus(u.path.split("/search/", 1)[1].strip("/").split("/")[0])
            if not q and engine == "magnific" and "/search/" in u.path:
                q = unquote_plus(u.path.split("/search/", 1)[1].strip("/").split("/")[0])
        else:
            if key not in u.path:
                return None
            q = unquote_plus(u.path.split(key, 1)[1].strip("/").split("/")[0])
        q = _clean_query(q.replace("-", " ") if engine in ("pexels", "unsplash", "shutterstock") else q)
        return (engine, q) if q else None
    return None


# Canvas pages: every *.instructure.com host (and any extra one in CANVAS_HOSTS, e.g. the configured
# canvas.host) becomes "canvas", and course/assignment/quiz/item ids become ":id". Applied to every state
# (training files and live requests alike) via normalize_event.
CANVAS_HOSTS = set()
_CANVAS_ID = re.compile(r"/(courses|assignments|quizzes|items)/\d+")


def is_canvas_host(host):
    host = host.lower()
    return host == "canvas" or host.endswith(".instructure.com") or host in CANVAS_HOSTS


def _canvas_path(path):
    return _CANVAS_ID.sub(r"/\1/:id", path)


def normalize_event(c):
    """Old compact strings ("school.instructure.com/courses/123/modules") in the canvas form; others unchanged."""
    if not isinstance(c, str) or ":q=" in c or c.startswith("dl:"):
        return c
    host, sep, path = c.partition("/")
    if not is_canvas_host(host):
        return c
    return ("canvas" + _canvas_path("/" + path))[:MAX_HOST_PATH] if sep else "canvas"


def normalize_state(state):
    return [normalize_event(c) for c in state]


def compact_url(url):
    s = search_of(url)
    if s:
        return f"{s[0]}:q={s[1]}"
    try:
        u = urlsplit(url)
    except ValueError:
        return url[:MAX_PATH]
    path = (u.path or "/").lower()
    host = _host(u.netloc)
    if is_canvas_host(host):
        return "canvas" + _canvas_path(path)[:MAX_PATH]
    return host + path[:MAX_PATH]


def compact_download(name):
    base = str(name).replace("\\", "/").rsplit("/", 1)[-1]
    return "dl:" + base.lower()[:MAX_NAME]


def to_text(state):
    """laya reads this: oldest first, last MAX_EVENTS events, the newest prefixed "now: "."""
    if isinstance(state, str):
        return state
    items = [str(s) for s in list(state)[-MAX_EVENTS:]]
    if items:
        items[-1] = "now: " + items[-1]
    return " → ".join(items)


def trim_events(events, count, budget, keep=2):
    """Drop the oldest events while to_text(events) is over `budget` tokens (count(text) -> int), keeping at least
    the newest `keep`. If `keep` events are still too long the caller clips tokens; the newest event and its
    "now: " prefix are never dropped."""
    ev = list(events)[-MAX_EVENTS:]
    while len(ev) > keep and count(to_text(ev)) > budget:
        ev.pop(0)
    return ev
