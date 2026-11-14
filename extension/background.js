// Predictive moves, background part. Watches visits and downloads through Firefox's own APIs,
// keeps the last 5 events in storage ("ring"), runs the rule triggers and writes "staged" items
// for the new tab page to show. Nothing pops up and nothing runs until you press a key or click.
// Shapes: docs/predictive-moves-contract.md. Every helper call may fail (helper not installed).
import { loadConfig } from "./core/config.js";
import * as store from "./core/storage.js";
import {
  parseSearch, isSSO, isFrustration, frustrationText, canvasPage, quizPayload, DEFAULT_COURSE_EXTS,
  isCreative, isCreativeGoogle, isHarvest, HARVEST, HARVEST_EXTS, seqMatch, addStaged, pruneStaged, makeLabel, logLabels,
  stagedUrl, withSeeds, isEnabled, thresholdOf, compactState, layaPowerOk, isLowPowerDevice,
} from "./core/moves.js";

const RING = 5;
const MIN = 60e3;
const JIVVY = "https://jivvy-study.vercel.app/note/new";

// One storage read-modify-write at a time, so two events never overwrite each other's changes.
let chain = Promise.resolve();
const serial = (fn) => (chain = chain.then(fn).catch((err) => console.warn("Lifeboard moves:", err)));

async function native(msg) {
  try {
    return await browser.runtime.sendNativeMessage("hub_helper", msg);
  } catch {
    return null; // helper missing or failed: rules that need it just don't stage
  }
}

// ---- staged list ----
async function stage(items, moves) {
  const now = Date.now();
  let list = await store.get("staged", []);
  const ignored = [];
  for (const item of items) {
    if (!isEnabled(moves, item.move) || item.confidence < thresholdOf(moves, item.move)) continue;
    const r = addStaged(list, item, now);
    list = r.list;
    ignored.push(...r.expired);
  }
  await store.set("staged", list);
  await logLabels(store, ignored.map((i) => makeLabel(i, "ignored", now)));
}

async function prune() {
  const now = Date.now();
  const { keep, expired } = pruneStaged(await store.get("staged", []), now);
  if (!expired.length) return;
  await store.set("staged", keep);
  await logLabels(store, expired.map((i) => makeLabel(i, "ignored", now)));
}

// Tells the helper which item the global shortcut may open, and logs what it opened.
async function syncShortcut() {
  const [cfg, staged, moves] = [await loadConfig(), await store.get("staged", []), await store.get("moves", {})];
  const top = staged.find((i) => stagedUrl(i) && isEnabled(moves, i.move));
  const threshold = Math.max(cfg.moves.shortcutAt ?? 0.85, thresholdOf(moves, top?.move));
  const res = await native({ action: "stage", move: top ? { ...top, url: stagedUrl(top), threshold } : null });
  const fired = res?.ok && Array.isArray(res.fired) ? res.fired : [];
  if (!fired.length) return;
  let list = staged;
  const labels = [];
  for (const f of fired) {
    const i = list.find((x) => x.move === f.move && stagedUrl(x));
    labels.push(makeLabel(i || { move: f.move, source: "rule" }, "fired", f.t || Date.now()));
    if (i) list = list.filter((x) => x !== i);
  }
  await store.set("staged", list);
  await logLabels(store, labels);
}

async function updateBadge() {
  const staged = await store.get("staged", []);
  const ai = staged.some((i) => i.move === "search_frustration_escalator");
  try {
    await browser.browserAction.setBadgeText({ text: ai ? "AI" : "" });
    if (ai) await browser.browserAction.setBadgeBackgroundColor({ color: "#4a6cf7" });
  } catch {
    /* no toolbar button */
  }
}

let syncTimer;
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.staged) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => serial(async () => (await syncShortcut(), await updateBadge())), 500);
});

// ---- events ----
async function pushRing(event) {
  const ring = await store.get("ring", []);
  ring.push(event);
  const out = ring.slice(-RING);
  await store.set("ring", out);
  return out;
}

async function onVisit(item) {
  let u;
  try {
    u = new URL(item.url);
  } catch {
    return;
  }
  if (!/^https?:$/.test(u.protocol) || isSSO(u.hostname, u.pathname)) return;
  const cfg = await loadConfig();
  if (!cfg.moves.enabled) return;
  const now = Date.now();
  const t = Math.min(item.lastVisitTime || now, now);
  const search = parseSearch(u);
  const event = { kind: "visit", host: u.hostname.replace(/^www\./, ""), path: u.pathname, t, hour: new Date(t).getHours() };
  if (item.title) event.title = item.title;
  if (search) Object.assign(event, search);
  const ring = await pushRing(event);
  const moves = withSeeds(await store.get("moves", {}));
  await prune();

  let matched = false;
  const items = [];

  if (search?.engine === "google") {
    const f = isFrustration(ring, now);
    if (f) {
      matched = true;
      const text = frustrationText(f.queries);
      const base = { move: "search_frustration_escalator", confidence: 0.95, expires: now + 20 * MIN };
      items.push({ ...base, key: "gemini", label: "Ask Gemini", action: { type: "ask", route: "gemini", text } });
      items.push({ ...base, key: "claude", label: "Ask Claude", action: { type: "ask", route: "claude", text } });
    }
  }

  const page = canvasPage(item.url, cfg.canvas.host);
  if (page) {
    matched = true;
    items.push(...(await canvasItems(page, item, cfg, moves, now)));
  }

  if (search && (isCreative(search.engine) || isCreativeGoogle(ring, event))) {
    matched = true;
    if (isEnabled(moves, "creative_asset_router") && isHarvest(ring, now)) await store.set("harvestUntil", now + HARVEST.lastsMs);
  }

  for (const d of (await store.get("learned", {})).discovered || []) {
    if (Array.isArray(d.hosts) && d.hosts.length === 3 && d.url && seqMatch(ring, d.hosts, now)) {
      matched = true;
      items.push({ move: d.id, key: "seq", label: "Open " + d.hosts[2], confidence: d.laya?.p ?? 0.9, expires: now + 30 * MIN, action: { type: "open", url: d.url } });
    }
  }

  if (items.length) await stage(items, moves);
  else if (!matched && cfg.moves.layaStaging) askLaya(cfg, ring, moves); // not awaited: ~2 s, runs on its own
}

async function canvasItems(page, item, cfg, moves, now) {
  if (!isEnabled(moves, "canvas_study_bridge")) return [];
  const course = cfg.canvas.courses?.[page.courseId] || {};
  const base = { move: "canvas_study_bridge", confidence: 0.9 };
  if (page.kind === "assignment") {
    const exts = Array.isArray(course.exts) && course.exts.length ? course.exts : DEFAULT_COURSE_EXTS;
    const res = await native({ action: "recent_files", minutes: 30, exts });
    const files = res?.ok && Array.isArray(res.files) ? res.files : [];
    if (!files.length) return [];
    const n = files.length;
    return [{ ...base, key: "files:" + page.courseId, label: `${n} recent file${n === 1 ? "" : "s"} for this assignment`, expires: now + 120 * MIN, action: { type: "files", files } }];
  }
  const text = quizPayload({ courseName: course.name, title: item.title, url: item.url });
  const key = "quiz:" + item.url;
  return [
    { ...base, key: key + ":claude", label: "Ask Claude about this quiz", expires: now + 180 * MIN, action: { type: "ask", route: "claude", text } },
    { ...base, key: key + ":study", label: "Study this quiz in Jivvy", expires: now + 180 * MIN, action: { type: "copy-open", text, url: JIVVY } },
  ];
}

// The quiz title often arrives after the visit: stage the quiz again (same key replaces it).
browser.history.onTitleChanged?.addListener((info) =>
  serial(async () => {
    const cfg = await loadConfig();
    const page = canvasPage(info.url, cfg.canvas.host);
    if (!cfg.moves.enabled || page?.kind !== "quiz" || !info.title) return;
    const moves = withSeeds(await store.get("moves", {}));
    await stage(await canvasItems(page, info, cfg, moves, Date.now()), moves);
  }),
);

async function onDownload(delta) {
  if (delta.state?.current !== "complete") return;
  const [d] = await browser.downloads.search({ id: delta.id });
  if (!d?.filename) return;
  const name = d.filename.split(/[\\/]/).pop();
  const ext = (name.match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase();
  const now = Date.now();
  const cfg = await loadConfig();
  if (!cfg.moves.enabled) return;
  await pushRing({ kind: "download", host: hostOf(d.url), path: "", ext, name, t: now, hour: new Date(now).getHours() });
  const moves = withSeeds(await store.get("moves", {}));
  if (!HARVEST_EXTS.has(ext) || (await store.get("harvestUntil", 0)) <= now || !isEnabled(moves, "creative_asset_router")) return;

  // Add to the names already collected in the staged item.
  const old = (await store.get("staged", [])).find((i) => i.move === "creative_asset_router" && i.key === "harvest");
  const names = [...new Set([...(old?.action?.names || []), name])];
  const n = names.length, files = `${n} new file${n === 1 ? "" : "s"}`;
  const base = { move: "creative_asset_router", key: "harvest", confidence: 0.9, expires: now + 120 * MIN };
  if (cfg.assetFolder) {
    const folder = cfg.assetFolder.replace(/\/+$/, "").split("/").pop() || cfg.assetFolder;
    await stage([{ ...base, label: `Move ${files} to ${folder}`, action: { type: "move", names, dest: cfg.assetFolder } }], moves);
  } else {
    await stage([{ ...base, label: `Set an asset folder in Options to move ${files}`, action: { type: "open", url: browser.runtime.getURL("options.html"), names } }], moves);
  }
}

const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

// ---- laya fallback: at most once every 30 s, only when no rule matched ----
let lastLaya = 0;

// Power state from the helper (/sys/class/power_supply), cached ~60 s so it isn't polled on every event.
let power = { t: -Infinity, v: null };
async function powerState(now) {
  if (now - power.t > 60e3) {
    const r = await native({ action: "power" });
    power = { t: now, v: r?.ok ? { onBattery: !!r.on_battery, percent: Number.isFinite(r.percent) ? r.percent : null } : null };
  }
  return power.v;
}

// Where laya runs its inference (its /health infer_device), cached ~60 s; null when unreachable.
let inferDev = { t: -Infinity, v: null };
async function inferDevice(cfg, now) {
  if (now - inferDev.t > 60e3) {
    let v = null;
    try {
      const r = await fetch(cfg.laya.url.replace(/\/$/, "") + "/health", { signal: AbortSignal.timeout(2000) });
      v = (await r.json())?.infer_device ?? null;
    } catch {
      /* laya off */
    }
    inferDev = { t: now, v };
  }
  return inferDev.v;
}

async function layaAllowed(cfg, now) {
  const mode = cfg.moves?.layaBatteryMode || "ac_only";
  if (mode === "never") return false;
  if (mode === "always") return true;
  const dev = cfg.moves?.layaLowPowerOverride !== false ? await inferDevice(cfg, now) : null;
  return layaPowerOk(cfg.moves, dev && isLowPowerDevice(dev) ? null : await powerState(now), dev);
}

// LRU of /workflow answers, keyed by the last 3 compact events (max 200). Cleared when the service
// reports a different workflow fit (reloaded or retrained) and at browser startup.
const CACHE_MAX = 200;
const wfCache = new Map();
let wfFit;
const cacheKey = (state) => state.slice(-3).join("|");
function cacheGet(k) {
  if (!wfCache.has(k)) return undefined;
  const v = wfCache.get(k);
  wfCache.delete(k);
  wfCache.set(k, v);
  return v;
}
function cachePut(k, v) {
  wfCache.delete(k);
  wfCache.set(k, v);
  while (wfCache.size > CACHE_MAX) wfCache.delete(wfCache.keys().next().value);
}

async function askLaya(cfg, ring, moves) {
  const now = Date.now();
  if (!cfg.laya?.url || !(await layaAllowed(cfg, now))) return;
  const enabled = Object.keys(moves).filter((id) => isEnabled(moves, id));
  if (!enabled.length) return;
  const state = compactState(ring, cfg.canvas?.host); // short strings: fewer tokens, faster
  const key = cacheKey(state) + "#" + enabled.slice().sort().join(",");
  let out = cacheGet(key);
  if (!out) {
    if (now - lastLaya < (isLowPowerDevice(inferDev.v) && cfg.moves?.layaLowPowerOverride !== false ? 8e3 : 30e3)) return; // low-power device: 8 s
    lastLaya = now;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(cfg.laya.url.replace(/\/$/, "") + "/workflow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state, moves: enabled }),
        signal: ctrl.signal,
      });
      out = await res.json();
    } catch {
      return; // laya off or slow
    } finally {
      clearTimeout(timer);
    }
    if (out?.ok) {
      if (wfFit !== undefined && out.fit !== wfFit) wfCache.clear();
      wfFit = out.fit ?? null;
      cachePut(key, out);
    }
  }
  const next = out?.next_move;
  // Measured accuracy is low, so only confident "auto" answers stage anything.
  if (!out?.ok || out.should_stage?.choice !== "yes" || next?.route !== "auto" || !enabled.includes(next.choice)) return;
  if (!(next.p >= thresholdOf(moves, next.choice))) return;
  const item = await layaItem(next.choice, ring, now);
  if (item) serial(() => stage([{ ...item, move: next.choice, key: "laya", source: "laya", confidence: next.p, expires: now + 30 * MIN }], moves));
}

// laya names a move; only moves that need no extra context can be staged from that alone.
async function layaItem(id, ring, now) {
  const d = ((await store.get("learned", {})).discovered || []).find((x) => x.id === id);
  if (d?.url) return { label: "Open " + (d.hosts?.[2] || hostOf(d.url)), action: { type: "open", url: d.url } };
  const g = [...ring].reverse().find((e) => e.engine === "google" && e.query && now - e.t < 5 * MIN);
  if (id === "search_frustration_escalator" && g) return { label: "Ask Claude", action: { type: "ask", route: "claude", text: g.query } };
  return null;
}

// ---- learned data, seeds, timers ----
async function refreshLearned() {
  const res = await native({ action: "discovered" });
  if (res?.ok && res.learned) await store.set("learned", res.learned);
}

async function ensureMoves() {
  const moves = await store.get("moves", {});
  const full = withSeeds(moves);
  if (Object.keys(full).length !== Object.keys(moves).length) await store.set("moves", full);
}

browser.runtime.onInstalled.addListener(() => serial(async () => (await ensureMoves(), await refreshLearned())));
browser.runtime.onStartup.addListener(() => serial(async () => (wfCache.clear(), await refreshLearned())));
browser.alarms.create("learned", { delayInMinutes: 1, periodInMinutes: 1440 });
browser.alarms.create("prune", { periodInMinutes: 15 });
browser.alarms.onAlarm.addListener((a) => {
  if (a.name === "learned") serial(refreshLearned);
  if (a.name === "prune") serial(async () => (await prune(), await syncShortcut()));
});
browser.history.onVisited.addListener((item) => serial(() => onVisit(item)));
browser.downloads.onChanged.addListener((delta) => serial(() => onDownload(delta)));
browser.browserAction.onClicked.addListener(() => browser.tabs.create({ url: browser.runtime.getURL("newtab.html?f=1") }));
serial(async () => (await ensureMoves(), await prune(), await updateBadge()));
