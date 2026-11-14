// Predictive moves: the pure parts (no browser calls), shared by background.js, the new tab
// page and tests/moves.test.mjs. Shapes follow docs/predictive-moves-contract.md.
// Seeds are generic; your own aliases, courses and counts come from storage ("learned").

export const SEEDS = [
  {
    id: "nav_shortcut_interceptor",
    title: "Go straight to sites you type",
    trigger: "You type a site name you usually search for (typos up to 2 letters off, for words over 5 letters).",
    action: "The box offers the site itself; Enter opens it.",
    threshold: 0.85,
  },
  {
    id: "search_frustration_escalator",
    title: "Ask an AI after repeated searches",
    trigger: "Two or more similar Google searches within 45 seconds, or one very long search repeated.",
    action: "Stages “Ask Claude” and “Ask Gemini” with your latest search and the earlier tries. You still press send.",
    threshold: 0.85,
  },
  {
    id: "canvas_study_bridge",
    title: "Canvas assignments and quizzes",
    trigger: "You open a Canvas assignment or quiz page.",
    action: "Assignments: lists files you changed in Downloads in the last 30 minutes. Quizzes: copies the quiz details and opens a study app or Claude.",
    threshold: 0.85,
  },
  {
    id: "creative_asset_router",
    title: "Collect design downloads",
    trigger: "Three or more searches on Pinterest or stock photo sites within 5 minutes start a 60-minute collecting window.",
    action: "Images and fonts you download meanwhile can be moved to your asset folder with one click (with Undo).",
    threshold: 0.85,
  },
  {
    id: "inline_unit_camera_calc",
    title: "Answer unit math while you type",
    trigger: "Box text like “157919MB to gb”, “1.43 kg to lb”, “27000 mAh” or “8tb at 400mbps”.",
    action: "The hint line shows the answer. Enter still searches.",
    threshold: 0.85,
  },
];
export const SEED_IDS = SEEDS.map((s) => s.id);

// ---- search URLs ----
const CREATIVE = new Set(["pinterest", "pexels", "pixabay", "magnific", "freepik", "unsplash", "dreamstime", "shutterstock", "vecteezy", "freerangestock"]);
export const isCreative = (engine) => CREATIVE.has(engine);

// A Google query is creative (not "frustration") when it asks for stock imagery by name, or comes
// within 120 s of a visit to a creative site. Twin of creative_google in helper/train_workflow_cli.py.
export const CREATIVE_QUERY = /free image|free photo|stock image|illustration/i;
export const CREATIVE_NEAR_MS = 120e3;
const creativeHost = (host) => String(host || "").toLowerCase().split(".").some((l) => CREATIVE.has(l));
export function isCreativeGoogle(ring, e) {
  if (!e || e.engine !== "google" || !e.query) return false;
  if (CREATIVE_QUERY.test(e.query)) return true;
  return (ring || []).some((x) => x !== e && x.kind === "visit" && x.t <= e.t && e.t - x.t <= CREATIVE_NEAR_MS && (isCreative(x.engine) || creativeHost(x.host)));
}

const fromPath = (seg) => {
  try {
    seg = decodeURIComponent(seg);
  } catch {
    /* keep the raw segment */
  }
  return seg.replace(/[-+_]+/g, " ").trim();
};

// → { engine, query } or null. Lenient: any of q / query / term / text for the stock sites.
export function parseSearch(url) {
  let u;
  try {
    u = url instanceof URL ? url : new URL(url);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const path = u.pathname;
  const p = (...names) => {
    for (const n of names) {
      const v = u.searchParams.get(n);
      if (v && v.trim()) return v.trim();
    }
    return null;
  };
  const out = (engine, query) => (query ? { engine, query: query.replace(/\s+/g, " ").trim() } : null);

  if (/^google\.[a-z.]+$/.test(host) && path === "/search") return out("google", p("q"));
  if (/(^|\.)duckduckgo\.com$/.test(host)) return out("duckduckgo", p("q"));
  if (/(^|\.)bing\.com$/.test(host) && path.startsWith("/search")) return out("bing", p("q"));
  if (/(^|\.)pinterest\.[a-z.]+$/.test(host) && path.startsWith("/search/")) return out("pinterest", p("q"));

  const m = (re) => path.match(re)?.[1];
  for (const engine of ["pexels", "pixabay", "magnific", "freepik", "unsplash", "dreamstime", "shutterstock", "vecteezy", "freerangestock"]) {
    if (!new RegExp(`(^|\\.)${engine}\\.[a-z.]+$`).test(host)) continue;
    const q = p("q", "query", "term", "text", "srh_field", "qterm");
    if (q) return out(engine, q);
    // /search/<q>/, /en-us/search/<q>/, /images/search/<q>/, /photos/search/<q>/, unsplash /s/photos/<q>
    const seg = m(/\/search\/(?:photos\/|videos\/|images\/)?([^/]+)\/?$/) || m(/^\/s\/[^/]+\/([^/]+)/);
    if (seg) return out(engine, fromPath(seg));
    return null;
  }
  return null;
}

// ---- similarity ----
export const tokens = (s) => String(s || "").toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];

// Jaccard similarity of the two word sets (0..1).
export function similarity(a, b) {
  const A = new Set(tokens(a)), B = new Set(tokens(b));
  if (!A.size && !B.size) return 0;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both / (A.size + B.size - both);
}

export const FRUSTRATION = { windowMs: 45e3, minSim: 0.55, longWords: 12, sameSearchMs: 5e3 };

// ring: events (any order), each { kind, engine?, query?, t }.
// True when 2+ Google searches fall within 45 s of the newest one and the newest is similar
// (Jaccard > 0.55) to an earlier one, or the newest is over 12 words long.
// The same query again within 5 s is one search (Google often logs two visits), not a retry.
// → { queries: [oldest … newest] } (distinct) or null.
export function isFrustration(ring, now = Date.now()) {
  const all = (ring || []).filter((e) => e.kind === "visit" && e.engine === "google" && e.query).sort((a, b) => a.t - b.t);
  const s = [];
  for (const e of all) {
    const prev = s[s.length - 1];
    if (prev && prev.query.toLowerCase() === e.query.toLowerCase() && e.t - prev.t < FRUSTRATION.sameSearchMs) continue;
    s.push(e);
  }
  const newest = s[s.length - 1];
  if (!newest || now - newest.t > FRUSTRATION.windowMs) return null;
  if (isCreativeGoogle(ring, newest)) return null; // stock-image hunting is creative_asset_router, even when long
  const recent = s.filter((e) => newest.t - e.t <= FRUSTRATION.windowMs);
  if (recent.length < 2) return null;
  const earlier = recent.slice(0, -1);
  const long = tokens(newest.query).length > FRUSTRATION.longWords;
  if (!long && !earlier.some((e) => similarity(e.query, newest.query) > FRUSTRATION.minSim)) return null;
  const seen = new Set(), queries = [];
  for (const e of recent) {
    const k = e.query.toLowerCase();
    if (!seen.has(k)) seen.add(k), queries.push(e.query);
  }
  return { queries };
}

// Text for "Ask Claude/Gemini": the earlier tries as a list, then the latest search.
export function frustrationText(queries) {
  const latest = queries[queries.length - 1];
  const tries = queries.slice(0, -1);
  const list = tries.length ? tries.map((q) => "- " + q).join("\n") + "\n\n" : "\n";
  return "I searched Google for this and didn't find it:\n" + list + latest;
}

// ---- sign-in pages: never part of a pattern (A → login → B counts as A → B) ----
export const SSO_HOSTS = ["login.microsoftonline.com", "sso.canvaslms.com", "accounts.google.com", "accounts.firefox.com", "auth.openai.com"];
const SSO_PATH = /\/(oauth|saml|sso)|\/cdn-cgi\/access\//i; // "contains /oauth", so /oauth2/… too

export function isSSO(host, path = "/") {
  host = String(host || "").toLowerCase();
  if (SSO_HOSTS.includes(host) || host === "cloudflareaccess.com" || host.endsWith(".cloudflareaccess.com")) return true;
  return SSO_PATH.test(path || "/");
}

// ---- Canvas ----
export function canvasPage(url, host = "school.instructure.com") {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.hostname.toLowerCase() !== String(host).toLowerCase()) return null;
  const m = u.pathname.match(/^\/courses\/(\d+)\/(assignments|quizzes)\/(\d+)/);
  if (!m) return null;
  return { courseId: m[1], kind: m[2] === "quizzes" ? "quiz" : "assignment" };
}

export const DEFAULT_COURSE_EXTS = ["tif", "jpg", "png", "pdf", "indd", "idml"];

export function quizPayload({ courseName, title, url }) {
  return `Course: ${courseName || "—"} | Quiz: ${title || "—"} | URL: ${url}`;
}

// ---- creative "harvest" window ----
export const HARVEST = { searches: 3, windowMs: 5 * 60e3, lastsMs: 60 * 60e3 };
export const HARVEST_EXTS = new Set(["jpg", "jpeg", "png", "webp", "gif", "svg", "tif", "tiff", "heic", "avif", "ttf", "otf", "woff", "woff2", "zip"]);

// 3+ searches on creative sites within the last 5 minutes.
export function isHarvest(events, now = Date.now()) {
  const n = (events || []).filter((e) => e.kind === "visit" && (isCreative(e.engine) || isCreativeGoogle(events, e)) && e.query && now - e.t <= HARVEST.windowMs && e.t <= now).length;
  return n >= HARVEST.searches;
}

// ---- discovered 3-step sequences: you visited hosts[0] then hosts[1] (last 10 min) → stage hosts[2] ----
export function seqMatch(ring, hosts, now = Date.now(), windowMs = 10 * 60e3) {
  const visits = [];
  for (const e of (ring || []).filter((e) => e.kind === "visit" && now - e.t <= windowMs).sort((a, b) => a.t - b.t)) {
    if (visits[visits.length - 1] !== e.host) visits.push(e.host);
  }
  const n = visits.length;
  return n >= 2 && visits[n - 2] === hosts[0] && visits[n - 1] === hosts[1];
}

// ---- nav aliases ----
// Damerau-Levenshtein (optimal string alignment): insert, delete, substitute, swap neighbours.
export function editDistance(a, b) {
  const n = a.length, m = b.length;
  if (!n) return m;
  if (!m) return n;
  let pp = null, p = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const c = [i];
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      c[j] = Math.min(p[j] + 1, c[j - 1] + 1, p[j - 1] + cost);
      if (pp && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) c[j] = Math.min(c[j], pp[j - 2] + 1);
    }
    pp = p;
    p = c;
  }
  return p[m];
}

const norm = (s) => String(s || "").toLowerCase().trim().replace(/\s+/g, " ");

// Exact alias, or (when the text has more than 5 letters) the closest alias at most 2 edits away.
// → { key, url } or null.
export function matchAlias(text, aliases) {
  const t = norm(text);
  if (!t || !aliases) return null;
  const entries = Object.entries(aliases).filter(([, url]) => typeof url === "string" && url);
  for (const [k, url] of entries) if (norm(k) === t) return { key: k, url };
  if ((t.match(/\p{L}/gu) || []).length <= 5) return null;
  let best = null, bestD = 3;
  for (const [k, url] of entries) {
    const key = norm(k);
    if (Math.abs(key.length - t.length) > 2) continue;
    const d = editDistance(t, key);
    if (d < bestD) (best = { key: k, url }), (bestD = d);
  }
  return best;
}

// ---- staged items ----
export const STAGED_CAP = 12;
export const IGNORE_AFTER_TABS = 8;
export const WEIGHTS = { fired: 1, dismissed: 1, ignored: 0.3 };
export const LABELS_CAP = 2000;

const keyOf = (i) => i.move + "|" + (i.key ?? "");

// Splits off items that expired or were shown on 8+ new tabs without being used.
// → { keep, expired } (the caller logs expired ones as "ignored").
export function pruneStaged(list, now = Date.now()) {
  const keep = [], expired = [];
  for (const i of list || []) {
    if ((i.expires && i.expires <= now) || (i.tabsSeen || 0) >= IGNORE_AFTER_TABS) expired.push(i);
    else keep.push(i);
  }
  return { keep, expired };
}

// Adds an item at the front. An item with the same move and key replaces the old one.
// → { list, expired }
export function addStaged(list, item, now = Date.now()) {
  const { keep, expired } = pruneStaged(list, now);
  const full = {
    source: "rule",
    expires: null,
    tabsSeen: 0,
    ...item,
    t: item.t ?? now,
    id: item.id || `${item.move}:${now.toString(36)}:${Math.random().toString(36).slice(2, 7)}`,
  };
  const out = [full, ...keep.filter((i) => keyOf(i) !== keyOf(full))].slice(0, STAGED_CAP);
  return { list: out, expired };
}

// A label for moveLabels, or null for items that aren't predictions (Undo pills).
export function makeLabel(item, outcome, now = Date.now()) {
  if (!item || !(outcome in WEIGHTS) || item.action?.type === "undo-move") return null;
  return { move: item.move, outcome, weight: WEIGHTS[outcome], t: now, source: item.source === "laya" ? "laya" : "rule" };
}

// store: core/storage.js (passed in so this file stays pure).
export async function logLabels(store, labels) {
  labels = (labels || []).filter(Boolean);
  if (!labels.length) return;
  const list = await store.get("moveLabels", []);
  list.push(...labels);
  await store.set("moveLabels", list.slice(-LABELS_CAP));
}

// The address the global shortcut (helper/lifeboard-next) opens for an open/ask item, or null.
export function stagedUrl(item) {
  const a = item?.action;
  if (!a) return null;
  if (a.type === "open") return /^https?:\/\//i.test(a.url || "") ? a.url : null;
  if (a.type === "ask") return a.route === "gemini" ? "https://gemini.google.com/app" : "https://claude.ai/new?q=" + encodeURIComponent(a.text || "");
  return null;
}

// Moves map with every seed present (status "new" until you review it in the drawer).
export function withSeeds(moves = {}) {
  const out = { ...moves };
  for (const s of SEEDS) if (!out[s.id]) out[s.id] = { status: "new", threshold: s.threshold };
  return out;
}

export const isEnabled = (moves, id) => moves?.[id]?.status === "enabled";
export const thresholdOf = (moves, id) => moves?.[id]?.threshold ?? 0.85;

// ---- compact workflow state (docs/predictive-moves-contract.md; twin of helper/workflow_state.py) ----
// Short strings laya reads fast: "host/path", "<engine>:q=<query>", "dl:<file>".
// Canvas pages: any *.instructure.com host (and the configured canvas.host) becomes "canvas", and
// /courses|assignments|quizzes|items/<n> becomes /…/:id, like normalize_event in workflow_state.py.
const canvasHostOf = (h, extra) => /(^|\.)instructure\.com$/.test(h) || (!!extra && h === String(extra).toLowerCase());
const canvasPath = (p) => p.replace(/\/(courses|assignments|quizzes|items)\/\d+/g, "/$1/:id");
const hostPath = (host, path, canvasHost) => {
  host = (host || "").toLowerCase().replace(/^www\./, "");
  path = (path || "/").toLowerCase();
  return canvasHostOf(host, canvasHost) ? "canvas" + canvasPath(path).slice(0, 40) : host + path.slice(0, 40);
};

export function compactEvent(ev, canvasHost) {
  if (!ev) return "";
  if (ev.kind === "download") return "dl:" + String(ev.name || "").split(/[\\/]/).pop().toLowerCase().slice(0, 40);
  if (ev.engine && ev.query) return `${ev.engine}:q=${ev.query.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 60)}`;
  return hostPath(ev.host, ev.path, canvasHost);
}

export function compactUrl(url, canvasHost) {
  const s = parseSearch(url);
  if (s) return compactEvent({ kind: "visit", ...s });
  try {
    const u = new URL(url);
    return compactEvent({ kind: "visit", host: u.hostname, path: u.pathname }, canvasHost);
  } catch {
    return String(url).slice(0, 40);
  }
}

// The state laya gets: the last 5 events, oldest first.
export const compactState = (ring, canvasHost) => ring.slice(-5).map((e) => compactEvent(e, canvasHost));

// Laya in the background vs power. moves.layaBatteryMode: "ac_only" (default: laya only on AC, on battery just the
// rules), "always", "threshold" (on battery only at moves.layaBatteryMinPercent, default 40, or more), "never".
// power: { onBattery, percent } from the helper, or null when it can't be read: then only the rules run.
export function layaPowerOk(moves, power, inferDevice) {
  const mode = moves?.layaBatteryMode || "ac_only";
  if (mode === "never") return false;
  if (mode === "always") return true;
  if (moves?.layaLowPowerOverride !== false && isLowPowerDevice(inferDevice)) return true; // NPU / iGPU: cheap enough for battery
  if (!power) return false;
  if (!power.onBattery) return true;
  return mode === "threshold" && power.percent !== null && power.percent !== undefined && power.percent >= (moves?.layaBatteryMinPercent ?? 40);
}

// laya's infer_device: "npu" or "gpu" (OpenVINO, the Arc iGPU) draw little power; "cpu" and "cuda" do not.
export const isLowPowerDevice = (d) => /^(npu|gpu)/i.test(String(d || ""));
