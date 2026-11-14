import { readFileSync } from "node:fs";
// Run: node tests/moves.test.mjs
import "../extension/rules/basic.js";
import "../extension/rules/nav-aliases.js";
import "../extension/routes/open-url.js";
import {
  parseSearch, similarity, tokens, isFrustration, frustrationText, isSSO, canvasPage, isHarvest, matchAlias, quizPayload,
  addStaged, pruneStaged, makeLabel, stagedUrl, seqMatch, withSeeds, SEEDS, STAGED_CAP, compactUrl, compactEvent, compactState,
  isCreativeGoogle, layaPowerOk, isLowPowerDevice, isCreative,
} from "../extension/core/moves.js";
import { calc } from "../extension/core/calc.js";
import { merge } from "../extension/core/config.js";
import { decide } from "../extension/core/router.js";
import { registerRoute, urlRoute } from "../extension/core/registry.js";

let fail = 0;
const check = (name, ok) => (ok || fail++, console.log(`${ok ? "ok  " : "FAIL"} ${name}`));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- seeds ----
check("5 seeded moves, threshold 0.85", SEEDS.length === 5 && SEEDS.every((s) => s.threshold === 0.85 && s.title && s.trigger && s.action));
check("seeds start as new", Object.values(withSeeds({})).every((m) => m.status === "new"));
check("withSeeds keeps your status", withSeeds({ canvas_study_bridge: { status: "enabled", threshold: 0.9 } }).canvas_study_bridge.status === "enabled");

// ---- parseSearch ----
const ps = [
  ["https://www.google.com/search?q=ibis+2026&sca=x", { engine: "google", query: "ibis 2026" }],
  ["https://www.google.co.uk/search?q=hello%20world", { engine: "google", query: "hello world" }],
  ["https://www.google.com/maps?q=x", null],
  ["https://duckduckgo.com/?q=rust+traits", { engine: "duckduckgo", query: "rust traits" }],
  ["https://www.bing.com/search?q=weather", { engine: "bing", query: "weather" }],
  ["https://www.pinterest.com/search/pins/?q=poster%20layout&rs=typed", { engine: "pinterest", query: "poster layout" }],
  ["https://www.pexels.com/search/red%20car/", { engine: "pexels", query: "red car" }],
  ["https://www.pexels.com/en-us/search/mountain/", { engine: "pexels", query: "mountain" }],
  ["https://pixabay.com/images/search/blue-sky/", { engine: "pixabay", query: "blue sky" }],
  ["https://pixabay.com/images/search/?q=forest", { engine: "pixabay", query: "forest" }],
  ["https://www.magnific.com/search?q=texture", { engine: "magnific", query: "texture" }],
  ["https://example.com/search?q=x", null],
  ["not a url", null],
];
for (const [url, want] of ps) check(`parseSearch ${url}`, eq(parseSearch(url), want));

// ---- similarity / frustration ----
const g = (query, t) => ({ kind: "visit", engine: "google", query, t });
const a = "can you get around not having ibis in 2026", b = "can you get around not having ibis 2026 l mount";
check("similar ibis queries > 0.55", similarity(a, b) > 0.55);
const T = 1_000_000;
check("two similar searches 20 s apart → frustration", eq(isFrustration([g(a, T), g(b, T + 20e3)], T + 20e3)?.queries, [a, b]));
check("50 s apart → no", isFrustration([g(a, T), g(b, T + 50e3)], T + 50e3) === null);
check("dissimilar short → no", isFrustration([g("pizza near me", T), g("weather tomorrow", T + 10e3)], T + 10e3) === null);
const long = "why does my laptop fan keep running at full speed even when nothing is open on linux";
check("long query repeated → yes", isFrustration([g(long, T), g(long, T + 15e3)], T + 15e3) !== null);
check("same query twice within 5 s is one search", isFrustration([g(long, T), g(long, T + 1e3)], T + 1e3) === null);
check("one search → no", isFrustration([g(long, T)], T) === null);
check("old burst doesn't count later", isFrustration([g(a, T), g(b, T + 20e3)], T + 120e3) === null);
check("other engines ignored", isFrustration([{ ...g(a, T), engine: "bing" }, { ...g(b, T + 5e3), engine: "bing" }], T + 5e3) === null);
check("frustration text lists earlier tries", frustrationText([a, b]) === `I searched Google for this and didn't find it:\n- ${a}\n\n${b}`);

// ---- SSO ----
for (const [h, p, want] of [
  ["login.microsoftonline.com", "/common/oauth2/authorize", true],
  ["sso.canvaslms.com", "/", true],
  ["accounts.google.com", "/v3/signin", true],
  ["accounts.firefox.com", "/", true],
  ["team.cloudflareaccess.com", "/", true],
  ["auth.openai.com", "/log-in", true],
  ["example.com", "/oauth/callback", true],
  ["example.com", "/saml2/acs", true],
  ["example.com", "/cdn-cgi/access/login", true],
  ["docs.google.com", "/document/d/1", false],
  ["example.com", "/", false],
]) check(`SSO ${h}${p} → ${want}`, isSSO(h, p) === want);

// ---- Canvas ----
check("assignment page", eq(canvasPage("https://school.instructure.com/courses/123/assignments/456"), { courseId: "123", kind: "assignment" }));
check("quiz page", eq(canvasPage("https://school.instructure.com/courses/123/quizzes/9?x=1"), { courseId: "123", kind: "quiz" }));
check("assignment list isn't a page", canvasPage("https://school.instructure.com/courses/123/assignments") === null);
check("other host", canvasPage("https://other.instructure.com/courses/1/assignments/2") === null);
check("custom host", canvasPage("https://school.instructure.com/courses/1/assignments/2", "school.instructure.com")?.kind === "assignment");
check("quiz payload", quizPayload({ courseName: "Photography I", title: "Quiz 3", url: "https://x/q" }) === "Course: Photography I | Quiz: Quiz 3 | URL: https://x/q");

// ---- harvest ----
const c = (engine, t) => ({ kind: "visit", engine, query: "poster", t });
check("3 creative searches in 5 min → harvest", isHarvest([c("pinterest", T), c("pexels", T + 60e3), c("pixabay", T + 120e3)], T + 120e3));
check("2 searches → no", !isHarvest([c("pinterest", T), c("pexels", T + 60e3)], T + 60e3));
check("spread over 6 min → no", !isHarvest([c("pinterest", T), c("pexels", T + 60e3), c("pixabay", T + 360e3)], T + 360e3));
check("google searches don't count", !isHarvest([c("google", T), c("google", T + 1), c("google", T + 2)], T + 2));

// ---- sequences ----
const v = (host, t) => ({ kind: "visit", host, t });
check("seq a → b matches", seqMatch([v("a.com", T), v("b.com", T + 60e3)], ["a.com", "b.com", "c.com"], T + 60e3));
check("seq repeated host collapses", seqMatch([v("a.com", T), v("b.com", T + 1), v("b.com", T + 2)], ["a.com", "b.com", "c.com"], T + 2));
check("seq wrong order", !seqMatch([v("b.com", T), v("a.com", T + 1)], ["a.com", "b.com", "c.com"], T + 1));

// ---- nav aliases ----
const aliases = { "eagles nest": "https://portal.example.edu/", "google drive": "https://drive.google.com/", calendar: "https://calendar.google.com/", drive: "https://drive.google.com/" };
check("exact alias", matchAlias("Eagles Nest", aliases)?.key === "eagles nest");
check("egales nest → eagles nest", matchAlias("egales nest", aliases)?.key === "eagles nest");
check("google dive → google drive", matchAlias("google dive", aliases)?.key === "google drive");
check("calandar → calendar", matchAlias("calandar", aliases)?.key === "calendar");
check("dirve: 5 letters, no fuzzy match", matchAlias("dirve", aliases) === null);
check("drive exact still works", matchAlias("drive", aliases)?.url === "https://drive.google.com/");
check("far text → none", matchAlias("weather tomorrow", aliases) === null);

const cfg = merge({ navAliases: aliases });
cfg.allProjects = [];
for (const d of cfg.urlRoutes) registerRoute(urlRoute(d));
const d = decide("calandar", cfg);
check("router: alias opens the URL", d.route === "open-url" && d.text === "https://calendar.google.com/" && d.raw === "calandar" && d.why === "you usually go here");
check("router: no aliases → normal", decide("calandar", merge({ navAliases: {} })).route === "search");
check("router: web address still wins", decide("github.com", cfg).text === "github.com");

// ---- staged items and labels ----
const N = 5_000_000;
let list = [];
for (let i = 0; i < 15; i++) list = addStaged(list, { move: "m", key: "k" + i, label: "x", confidence: 1, action: { type: "open", url: "https://a" } }, N).list;
check(`cap ${STAGED_CAP}, newest first`, list.length === STAGED_CAP && list[0].key === "k14");
list = addStaged(list, { move: "m", key: "k14", label: "again", confidence: 1, action: { type: "open", url: "https://b" } }, N).list;
check("same move+key replaces", list.length === STAGED_CAP && list[0].label === "again" && list.filter((i) => i.key === "k14").length === 1);
check("ids are unique", new Set(list.map((i) => i.id)).size === list.length);
const items = [
  { id: "1", move: "m", tabsSeen: 3, expires: null },
  { id: "2", move: "m", tabsSeen: 7, expires: N + 1 },
  { id: "3", move: "m", tabsSeen: 8, expires: null },
  { id: "4", move: "m", tabsSeen: 0, expires: N - 1 },
];
const pr = pruneStaged(items, N);
check("3 tabs: kept (ignored only after 8)", pr.keep.some((i) => i.id === "1"));
check("8 tabs: ignored", pr.expired.some((i) => i.id === "3") && !pr.keep.some((i) => i.id === "3"));
check("expired: ignored", pr.expired.some((i) => i.id === "4"));
check("7 tabs, not expired: kept", pr.keep.some((i) => i.id === "2"));
check("addStaged returns expired ones", addStaged(items, { move: "z", label: "z", action: { type: "open", url: "https://z" } }, N).expired.length === 2);
check("label weights", eq(["fired", "dismissed", "ignored"].map((o) => makeLabel({ move: "m" }, o, 1).weight), [1, 1, 0.3]));
check("label shape", eq(makeLabel({ move: "m", source: "laya" }, "fired", 7), { move: "m", outcome: "fired", weight: 1, t: 7, source: "laya" }));
check("undo pills aren't labels", makeLabel({ move: "m", action: { type: "undo-move" } }, "ignored") === null);
check("stagedUrl: claude", stagedUrl({ action: { type: "ask", route: "claude", text: "a b" } }) === "https://claude.ai/new?q=a%20b");
check("stagedUrl: non-http open → null", stagedUrl({ action: { type: "open", url: "moz-extension://x/options.html" } }) === null);
check("stagedUrl: files → null", stagedUrl({ action: { type: "files", files: [] } }) === null);

// ---- calc ----
for (const [text, want] of [
  ["157919MB to gb", "= 157.92 GB · 147.07 GiB"],
  ["1.43 kg to lb", "= 3.15 lb"],
  ["1.7 lb to grams", "= 771 g"],
  ["27000 mah", "≈ 99.9 Wh at 3.7 V"],
  ["27000 mAh", "≈ 99.9 Wh at 3.7 V"],
  ["8tb at 400mbps", "= 44.4 h"],
  ["how long can an xt4 record on 2tb", "X-T4: 400 Mbps ≈ 11.1 h · 200 Mbps ≈ 22.2 h · 100 Mbps ≈ 44.4 h"],
  ["X-T4 512GB", "X-T4: 400 Mbps ≈ 2.8 h · 200 Mbps ≈ 5.7 h · 100 Mbps ≈ 11.4 h"],
  ["what is the best camera for 2026", null],
  ["explain how garbage collection works in java", null],
  ["xt4 battery life", null],
]) check(`calc “${text}” → ${want}`, calc(text) === want);
// compact state must match helper/workflow_state.py (shared vectors)
for (const v of JSON.parse(readFileSync(new URL("./workflow_state_vectors.json", import.meta.url)))) {
  const got = v.url ? compactUrl(v.url) : compactEvent({ kind: "download", name: v.download });
  check(`compact ${v.url || v.download} → ${v.out}`, got === v.out);
}
check("compactState keeps the last 5", compactState([1, 2, 3, 4, 5, 6].map((i) => ({ kind: "visit", host: "a.com", path: "/" + i }))).join() === "a.com/2,a.com/3,a.com/4,a.com/5,a.com/6");
// creative Google queries are not frustration (v0.4.2)
const gq = (query, t) => ({ kind: "visit", host: "google.com", path: "/search", engine: "google", query, t });
const T0 = 1e6;
check("dreamstime/shutterstock/vecteezy/freerangestock are creative engines", ["dreamstime", "shutterstock", "vecteezy", "freerangestock"].every(isCreative));
check("parseSearch shutterstock", eq(parseSearch("https://www.shutterstock.com/search/retro-poster"), { engine: "shutterstock", query: "retro poster" }));
check("parseSearch dreamstime srh_field", eq(parseSearch("https://www.dreamstime.com/search.php?srh_field=old+map"), { engine: "dreamstime", query: "old map" }));
check("free image query is not frustration", isFrustration([gq("retro poster free image", T0), gq("retro poster free image download", T0 + 20e3)], T0 + 20e3) === null);
const longCreative = "give me a free photo of a vintage typewriter on a wooden desk with warm window light and soft shadows";
check("long creative query is not frustration", tokens(longCreative).length > 12 && isFrustration([gq("typewriter", T0), gq(longCreative, T0 + 10e3)], T0 + 10e3) === null);
const ringNear = [{ kind: "visit", host: "shutterstock.com", path: "/search/retro", engine: "shutterstock", query: "retro", t: T0 }, gq("retro poster layout", T0 + 60e3), gq("retro poster layout ideas", T0 + 80e3)];
check("query within 120 s of a creative visit is creative", isCreativeGoogle(ringNear, ringNear[2]) && isFrustration(ringNear, T0 + 80e3) === null);
const ringFar = [{ ...ringNear[0] }, gq("retro poster layout", T0 + 200e3), gq("retro poster layout ideas", T0 + 220e3)];
check("after 120 s it is frustration again", !isCreativeGoogle(ringFar, ringFar[2]) && isFrustration(ringFar, T0 + 220e3) !== null);
check("plain pair is still frustration", isFrustration([gq("printer offline", T0), gq("printer offline error", T0 + 20e3)], T0 + 20e3) !== null);
check("creative google queries count toward harvest", isHarvest([gq("a free image", T0), gq("b free image", T0 + 1e3), gq("c illustration", T0 + 2e3)], T0 + 3e3));
// canvas fires on the page itself: assignment/quiz yes, /modules no
check("canvas: assignment and quiz fire, /modules afterwards does not", canvasPage("https://school.instructure.com/courses/1/assignments/2")?.kind === "assignment"
  && canvasPage("https://school.instructure.com/courses/1/quizzes/3")?.kind === "quiz" && canvasPage("https://school.instructure.com/courses/1/modules") === null);
// laya vs power
const pw = (mode, p, min) => layaPowerOk({ layaBatteryMode: mode, layaBatteryMinPercent: min }, p);
check("battery mode ac_only is the default", layaPowerOk({}, { onBattery: false, percent: 90 }) && !layaPowerOk({}, { onBattery: true, percent: 90 }) && !layaPowerOk(undefined, null));
check("battery mode always / never", pw("always", { onBattery: true, percent: 5 }) && pw("always", null) && !pw("never", { onBattery: false, percent: 100 }));
check("battery mode threshold", pw("threshold", { onBattery: true, percent: 40 }) && !pw("threshold", { onBattery: true, percent: 39 }) && pw("threshold", { onBattery: false, percent: 1 })
  && pw("threshold", { onBattery: true, percent: 60 }, 60) && !pw("threshold", { onBattery: true, percent: 59 }, 60) && !pw("threshold", { onBattery: true, percent: null }));
const bat = { onBattery: true, percent: 10 };
check("low-power device (npu/gpu) runs on battery, cpu/cuda do not", layaPowerOk({}, bat, "npu") && layaPowerOk({ layaBatteryMode: "threshold" }, bat, "GPU") && !layaPowerOk({}, bat, "cpu") && !layaPowerOk({}, bat, "cuda") && isLowPowerDevice("npu"));
check("override can be turned off; never always wins", !layaPowerOk({ layaLowPowerOverride: false }, bat, "npu") && !layaPowerOk({ layaBatteryMode: "never" }, bat, "npu") && layaPowerOk({}, null, "npu"));
check("helper unreachable: only rules run", !pw("ac_only", null) && !pw("threshold", null));
check("configured canvas host compacts to canvas", compactUrl("https://lms.example.edu/courses/12/quizzes/3", "lms.example.edu") === "canvas/courses/:id/quizzes/:id" && compactUrl("https://lms.example.edu/courses/12") === "lms.example.edu/courses/12"
  && compactState([{ kind: "visit", host: "lms.example.edu", path: "/courses/1/assignments/2" }], "lms.example.edu")[0] === "canvas/courses/:id/assignments/:id");
const sentence = "explain how garbage collection works in java and why 2 of them are slow";
const t0 = performance.now();
for (let i = 0; i < 20000; i++) calc(sentence);
console.log(`\ncalc: ${((performance.now() - t0) / 20000 * 1000).toFixed(1)} µs per sentence`);

console.log(fail ? `${fail} failed` : "all passed");
process.exit(fail ? 1 : 0);
