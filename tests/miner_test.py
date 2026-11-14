# Run: python3 -I tests/miner_test.py   (a made-up places.sqlite in a temp folder; laya is never asked)
import json, os, shutil, sqlite3, stat, subprocess, sys, tempfile, time
from pathlib import Path
TMP = Path(tempfile.mkdtemp())
PROFILE, SCRATCH, OUT = TMP / "profile", TMP / "scratch", TMP / "out"
for d in (PROFILE, SCRATCH):
    d.mkdir()
MINER = Path(__file__).resolve().parent.parent / "helper" / "pattern_miner.py"
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
day0 = time.time() - 20 * 86400
for d in range(5):  # 5 different days, an hour apart from anything else
    t = day0 + d * 86400
    # alias: "egales nest" -> eaglesnest, twice; "drive" once only (no alias)
    if d < 2:
        visit(t, G + "egales+nest"); visit(t + 20, "https://eaglesnest.school.edu/home")
    if d == 0:
        visit(t + 100, G + "drive"); visit(t + 110, "https://drive.google.com/drive/my-drive")
    # sequence A -> (Microsoft sign-in) -> B -> C, on 5 days: SSO page must not break it
    s = t + 1800
    visit(s, "https://alpha.example.com/")
    visit(s + 30, "https://login.microsoftonline.com/common/oauth2/authorize")
    visit(s + 40, "https://beta.example.com/cdn-cgi/access/login")  # SSO path: dropped too
    visit(s + 60, "https://beta.example.com/")
    visit(s + 120, "https://gamma.example.com/")
    # a sequence seen on only 2 days (4 times): below the day threshold
    if d < 2:
        for k in range(2):
            u = t + 3600 + k * 1200
            visit(u, "https://one.test/"); visit(u + 10, "https://two.test/"); visit(u + 20, "https://three.test/")
    # frustration: two similar google searches 20 s apart
    visit(t + 5000, G + "can+you+get+around+not+having+ibis"); visit(t + 5020, G + "can+you+get+around+not+having+ibis+app")
    # canvas
    visit(t + 7000, "https://school.instructure.com/courses/111/assignments/9", "Event Week 1: Sam Example")  # no name from this
    visit(t + 7050, "https://school.instructure.com/courses/111/modules", "Course Modules: ART 101: Photography I")
    visit(t + 7100, "https://school.instructure.com/courses/222", "Publication Design")
    visit(t + 7200, "https://school.instructure.com/courses/333/pages/x", "Music Links: ART 201-B: Media Tech")
    # a content search that led to the same site twice is not a nav alias
    visit(t + 9000, G + "ghost+story+book"); visit(t + 9010, "https://video.example.com/watch")
    # unit search
    visit(t + 8000, G + "157919mb+to+gb")
visit(day0 - 3600, "https://old.example.com/", vtype=9)  # a reload: ignored
visit(time.time() - 90 * 86400, "https://ancient.example.com/")
db.commit(); db.close()

def run(*args):
    r = subprocess.run([sys.executable, "-I", str(MINER), "--profile", str(PROFILE), "--no-laya", *args],
                       env=ENV, capture_output=True, text=True)
    return r

checks = []
r = run("--out", str(OUT / "discovered.json"), "--print")
out = json.loads((OUT / "discovered.json").read_text())
checks += [
    ("runs", r.returncode == 0, r.stderr[-300:]),
    ("alias egales nest", out["navAliases"].get("egales nest") == "https://eaglesnest.school.edu/", out["navAliases"]),
    ("single search is no alias", "drive" not in out["navAliases"], out["navAliases"]),
    ("content search is no alias", list(out["navAliases"]) == ["egales nest"], out["navAliases"]),
    ("sso skipped in sequence", [d["hosts"] for d in out["discovered"]] == [["alpha.example.com", "beta.example.com", "gamma.example.com"]],
     out["discovered"]),
    ("sequence shape", out["discovered"] and out["discovered"][0]["id"] == "seq_alpha-example-com_beta-example-com_gamma-example-com"
     and out["discovered"][0]["n"] == 5 and out["discovered"][0]["days"] == 5 and out["discovered"][0]["laya"] is None, out["discovered"]),
    ("frustration count", out["counts"]["search_frustration_escalator"]["n"] == 5, out["counts"]),
    ("canvas count", out["counts"]["canvas_study_bridge"]["n"] == 5, out["counts"]),
    ("calc count", out["counts"]["inline_unit_camera_calc"]["n"] == 5, out["counts"]),
    ("courses", out["canvasCourses"] == {"111": {"name": "Photography I", "exts": ["tif", "jpg", "png"]},
                                         "222": {"name": "Publication Design", "exts": ["pdf", "indd", "idml"]},
                                         "333": {"name": "Media Tech", "exts": ["pdf", "mp4", "mov"]}}, out["canvasCourses"]),
    ("print has no raw queries", "ibis" not in r.stdout and "157919" not in r.stdout, r.stdout),
    ("output 600", stat.S_IMODE(os.stat(OUT / "discovered.json").st_mode) == 0o600, oct(os.stat(OUT / "discovered.json").st_mode)),
    ("temp copy removed", list(SCRATCH.iterdir()) == [], list(SCRATCH.iterdir())),
    ("nothing in data dir", not (TMP / "data").exists(), "data dir created"),
]

intent = TMP / "intent.json"
intent.write_text(json.dumps({"profile": {"user": "Sam Example"}, "frequent_navigation_shortcuts_typed_as_searches": [
    "eagles nest / egales nest (7x)", "google drive / drive / google dive (12x)", "github (2x)", "calendar / calandar (4x)"]}))
r = run("--seed", str(intent), "--out", str(OUT / "seed.json"))
seed = json.loads((OUT / "seed.json").read_text())
checks += [
    ("seed runs", r.returncode == 0, r.stderr[-300:]),
    ("seed eagles nest", seed["navAliases"].get("eagles nest") == "https://eaglesnest.school.edu/", seed["navAliases"]),
    ("seed drive (known table, visited)", seed["navAliases"].get("google dive") == "https://drive.google.com/", seed["navAliases"]),
    ("seed unmatched", seed["unmatched"] == ["github (2x)", "calendar / calandar (4x)"], seed["unmatched"]),
    ("seed name", seed.get("name") == "Sam", seed.get("name")),
    ("seed 600", stat.S_IMODE(os.stat(OUT / "seed.json").st_mode) == 0o600, ""),
    ("seed temp removed", list(SCRATCH.iterdir()) == [], list(SCRATCH.iterdir())),
]

bad = 0
for name, good, detail in checks:
    bad += not good
    print(("ok  " if good else "FAIL"), name, "" if good else json.dumps(detail, default=str)[:300])
shutil.rmtree(TMP)
sys.exit(bad)
