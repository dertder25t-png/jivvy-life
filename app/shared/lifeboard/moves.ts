// Port of the pure parts of Lifeboard core/moves.js. No browser, storage or laya/NPU calls.
import type { PredictionSnapshot } from '../history-types.ts';

// ---- events (what the old extension called the "ring") ----
export interface RingEvent {
  kind: string; // "visit" | "download" | ...
  t: number;
  host?: string;
  path?: string;
  engine?: string;
  query?: string;
  name?: string;
}

// ---- search URLs ----
const CREATIVE = new Set(['pinterest', 'pexels', 'pixabay', 'magnific', 'freepik', 'unsplash', 'dreamstime', 'shutterstock', 'vecteezy', 'freerangestock']);
export const isCreative = (engine?: string): boolean => !!engine && CREATIVE.has(engine);

export const CREATIVE_QUERY = /free image|free photo|stock image|illustration/i;
export const CREATIVE_NEAR_MS = 120e3;
const creativeHost = (host?: string) => String(host || '').toLowerCase().split('.').some((l) => CREATIVE.has(l));

export function isCreativeGoogle(ring: RingEvent[] | undefined, e: RingEvent | undefined): boolean {
  if (!e || e.engine !== 'google' || !e.query) return false;
  if (CREATIVE_QUERY.test(e.query)) return true;
  return (ring || []).some((x) => x !== e && x.kind === 'visit' && x.t <= e.t && e.t - x.t <= CREATIVE_NEAR_MS && (isCreative(x.engine) || creativeHost(x.host)));
}

const fromPath = (seg: string) => {
  try {
    seg = decodeURIComponent(seg);
  } catch {
    /* keep the raw segment */
  }
  return seg.replace(/[-+_]+/g, ' ').trim();
};

/** → { engine, query } or null. Lenient: any of q / query / term / text for the stock sites. */
export function parseSearch(url: string | URL): { engine: string; query: string } | null {
  let u: URL;
  try {
    u = url instanceof URL ? url : new URL(url);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const path = u.pathname;
  const p = (...names: string[]) => {
    for (const n of names) {
      const v = u.searchParams.get(n);
      if (v && v.trim()) return v.trim();
    }
    return null;
  };
  const out = (engine: string, query: string | null) => (query ? { engine, query: query.replace(/\s+/g, ' ').trim() } : null);

  if (/^google\.[a-z.]+$/.test(host) && path === '/search') return out('google', p('q'));
  if (/(^|\.)duckduckgo\.com$/.test(host)) return out('duckduckgo', p('q'));
  if (/(^|\.)bing\.com$/.test(host) && path.startsWith('/search')) return out('bing', p('q'));
  if (/(^|\.)pinterest\.[a-z.]+$/.test(host) && path.startsWith('/search/')) return out('pinterest', p('q'));

  const m = (re: RegExp) => path.match(re)?.[1];
  for (const engine of ['pexels', 'pixabay', 'magnific', 'freepik', 'unsplash', 'dreamstime', 'shutterstock', 'vecteezy', 'freerangestock']) {
    if (!new RegExp(`(^|\\.)${engine}\\.[a-z.]+$`).test(host)) continue;
    const q = p('q', 'query', 'term', 'text', 'srh_field', 'qterm');
    if (q) return out(engine, q);
    const seg = m(/\/search\/(?:photos\/|videos\/|images\/)?([^/]+)\/?$/) || m(/^\/s\/[^/]+\/([^/]+)/);
    if (seg) return out(engine, fromPath(seg));
    return null;
  }
  return null;
}

// ---- similarity ----
export const tokens = (s: unknown): string[] => String(s || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];

/** Jaccard similarity of the two word sets (0..1). */
export function similarity(a: string, b: string): number {
  const A = new Set(tokens(a)), B = new Set(tokens(b));
  if (!A.size && !B.size) return 0;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both / (A.size + B.size - both);
}

export const FRUSTRATION = { windowMs: 45e3, minSim: 0.55, longWords: 12, sameSearchMs: 5e3 };

/**
 * True when 2+ Google searches fall within 45 s of the newest one and the newest is similar
 * (Jaccard > 0.55) to an earlier one, or the newest is over 12 words long.
 * The same query again within 5 s is one search. → { queries: [oldest … newest] } or null.
 */
export function isFrustration(ring: RingEvent[] | undefined, now: number = Date.now()): { queries: string[] } | null {
  const all = (ring || []).filter((e) => e.kind === 'visit' && e.engine === 'google' && e.query).sort((a, b) => a.t - b.t);
  const s: RingEvent[] = [];
  for (const e of all) {
    const prev = s[s.length - 1];
    if (prev && prev.query!.toLowerCase() === e.query!.toLowerCase() && e.t - prev.t < FRUSTRATION.sameSearchMs) continue;
    s.push(e);
  }
  const newest = s[s.length - 1];
  if (!newest || now - newest.t > FRUSTRATION.windowMs) return null;
  if (isCreativeGoogle(ring, newest)) return null;
  const recent = s.filter((e) => newest.t - e.t <= FRUSTRATION.windowMs);
  if (recent.length < 2) return null;
  const earlier = recent.slice(0, -1);
  const long = tokens(newest.query).length > FRUSTRATION.longWords;
  if (!long && !earlier.some((e) => similarity(e.query!, newest.query!) > FRUSTRATION.minSim)) return null;
  const seen = new Set<string>(), queries: string[] = [];
  for (const e of recent) {
    const k = e.query!.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      queries.push(e.query!);
    }
  }
  return { queries };
}

/** Text for "Ask Claude/Gemini": the earlier tries as a list, then the latest search. */
export function frustrationText(queries: string[]): string {
  const latest = queries[queries.length - 1];
  const tries = queries.slice(0, -1);
  const list = tries.length ? tries.map((q) => '- ' + q).join('\n') + '\n\n' : '\n';
  return "I searched Google for this and didn't find it:\n" + list + latest;
}

// ---- sign-in pages: never part of a pattern (A → login → B counts as A → B) ----
export const SSO_HOSTS = ['login.microsoftonline.com', 'sso.canvaslms.com', 'accounts.google.com', 'accounts.firefox.com', 'auth.openai.com'];
const SSO_PATH = /\/(oauth|saml|sso)|\/cdn-cgi\/access\//i;

export function isSSO(host: string, path = '/'): boolean {
  host = String(host || '').toLowerCase();
  if (SSO_HOSTS.includes(host) || host === 'cloudflareaccess.com' || host.endsWith('.cloudflareaccess.com')) return true;
  return SSO_PATH.test(path || '/');
}

// ---- Canvas ----
/**
 * A Canvas assignment or quiz page → { courseId, kind } or null.
 * Changed from Lifeboard: without `host`, any *.instructure.com host counts (no configured school needed).
 */
export function canvasPage(url: string, host?: string): { courseId: string; kind: 'quiz' | 'assignment' } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const h = u.hostname.toLowerCase();
  if (host ? h !== host.toLowerCase() : !/(^|\.)instructure\.com$/.test(h)) return null;
  const m = u.pathname.match(/^\/courses\/(\d+)\/(assignments|quizzes)\/(\d+)/);
  if (!m) return null;
  return { courseId: m[1], kind: m[2] === 'quizzes' ? 'quiz' : 'assignment' };
}

export const DEFAULT_COURSE_EXTS = ['tif', 'jpg', 'png', 'pdf', 'indd', 'idml'];

export function quizPayload({ courseName, title, url }: { courseName?: string; title?: string; url: string }): string {
  return `Course: ${courseName || '—'} | Quiz: ${title || '—'} | URL: ${url}`;
}

// ---- creative "harvest" window ----
export const HARVEST = { searches: 3, windowMs: 5 * 60e3, lastsMs: 60 * 60e3 };
export const HARVEST_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg', 'tif', 'tiff', 'heic', 'avif', 'ttf', 'otf', 'woff', 'woff2', 'zip']);

export function isHarvest(events: RingEvent[] | undefined, now: number = Date.now()): boolean {
  const n = (events || []).filter((e) => e.kind === 'visit' && (isCreative(e.engine) || isCreativeGoogle(events, e)) && e.query && now - e.t <= HARVEST.windowMs && e.t <= now).length;
  return n >= HARVEST.searches;
}

// ---- discovered 3-step sequences: you visited hosts[0] then hosts[1] (last 10 min) → stage hosts[2] ----
export function seqMatch(ring: RingEvent[] | undefined, hosts: readonly string[], now: number = Date.now(), windowMs = 10 * 60e3): boolean {
  const visits: (string | undefined)[] = [];
  for (const e of (ring || []).filter((e) => e.kind === 'visit' && now - e.t <= windowMs).sort((a, b) => a.t - b.t)) {
    if (visits[visits.length - 1] !== e.host) visits.push(e.host);
  }
  const n = visits.length;
  return n >= 2 && visits[n - 2] === hosts[0] && visits[n - 1] === hosts[1];
}

export type Sequence = PredictionSnapshot['sequences'][number];

/** Sequences from the snapshot whose first two hosts you just visited → what to stage next. Most-practiced first. */
export function matchSequences(ring: RingEvent[] | undefined, snapshot: Pick<PredictionSnapshot, 'sequences'> | undefined, now: number = Date.now(), windowMs = 10 * 60e3): Sequence[] {
  return (snapshot?.sequences || []).filter((s) => seqMatch(ring, s.hosts, now, windowMs)).sort((a, b) => b.n - a.n);
}

// ---- nav aliases ----
/** Damerau-Levenshtein (optimal string alignment): insert, delete, substitute, swap neighbours. */
export function editDistance(a: string, b: string): number {
  const n = a.length, m = b.length;
  if (!n) return m;
  if (!m) return n;
  let pp: number[] | null = null;
  let p = Array.from({ length: m + 1 }, (_, j) => j);
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

const norm = (s: unknown) => String(s || '').toLowerCase().trim().replace(/\s+/g, ' ');

/** Exact alias, or (when the text has more than 5 letters) the closest alias at most 2 edits away. */
export function matchAlias(text: string, aliases: Record<string, string> | undefined | null): { key: string; url: string } | null {
  const t = norm(text);
  if (!t || !aliases) return null;
  const entries = Object.entries(aliases).filter(([, url]) => typeof url === 'string' && url);
  for (const [k, url] of entries) if (norm(k) === t) return { key: k, url };
  if ((t.match(/\p{L}/gu) || []).length <= 5) return null;
  let best: { key: string; url: string } | null = null;
  let bestD = 3;
  for (const [k, url] of entries) {
    const key = norm(k);
    if (Math.abs(key.length - t.length) > 2) continue;
    const d = editDistance(t, key);
    if (d < bestD) {
      best = { key: k, url };
      bestD = d;
    }
  }
  return best;
}

// ---- staged items ----
export const STAGED_CAP = 12;
export const IGNORE_AFTER_TABS = 8;
export const WEIGHTS = { fired: 1, dismissed: 1, ignored: 0.3 } as const;
export const LABELS_CAP = 2000;

export interface StagedItem {
  move: string;
  key?: string;
  id?: string;
  t?: number;
  source?: string;
  expires?: number | null;
  tabsSeen?: number;
  action?: { type: string; url?: string; route?: string; text?: string; [k: string]: unknown };
  [k: string]: unknown;
}

const keyOf = (i: StagedItem) => i.move + '|' + (i.key ?? '');

/** Splits off items that expired or were shown on 8+ new tabs without being used. */
export function pruneStaged(list: StagedItem[] | undefined, now: number = Date.now()): { keep: StagedItem[]; expired: StagedItem[] } {
  const keep: StagedItem[] = [], expired: StagedItem[] = [];
  for (const i of list || []) {
    if ((i.expires && i.expires <= now) || (i.tabsSeen || 0) >= IGNORE_AFTER_TABS) expired.push(i);
    else keep.push(i);
  }
  return { keep, expired };
}

/** Adds an item at the front. An item with the same move and key replaces the old one. */
export function addStaged(list: StagedItem[] | undefined, item: StagedItem, now: number = Date.now()): { list: StagedItem[]; expired: StagedItem[] } {
  const { keep, expired } = pruneStaged(list, now);
  const full: StagedItem = {
    source: 'rule',
    expires: null,
    tabsSeen: 0,
    ...item,
    t: item.t ?? now,
    id: item.id || `${item.move}:${now.toString(36)}:${Math.random().toString(36).slice(2, 7)}`,
  };
  const out = [full, ...keep.filter((i) => keyOf(i) !== keyOf(full))].slice(0, STAGED_CAP);
  return { list: out, expired };
}

/** A label for the move-labels log, or null for items that aren't predictions (Undo pills). */
export function makeLabel(item: StagedItem | null | undefined, outcome: string, now: number = Date.now()): { move: string; outcome: string; weight: number; t: number; source: string } | null {
  if (!item || !(outcome in WEIGHTS) || item.action?.type === 'undo-move') return null;
  return { move: item.move, outcome, weight: WEIGHTS[outcome as keyof typeof WEIGHTS], t: now, source: 'rule' };
}

/** The address an open/ask staged item opens, or null. */
export function stagedUrl(item: StagedItem | null | undefined): string | null {
  const a = item?.action;
  if (!a) return null;
  if (a.type === 'open') return /^https?:\/\//i.test(a.url || '') ? a.url! : null;
  if (a.type === 'ask') return a.route === 'gemini' ? 'https://gemini.google.com/app' : 'https://claude.ai/new?q=' + encodeURIComponent(a.text || '');
  return null;
}

export const SEEDS = [
  { id: 'nav_shortcut_interceptor', title: 'Go straight to sites you type', threshold: 0.85 },
  { id: 'search_frustration_escalator', title: 'Ask an AI after repeated searches', threshold: 0.85 },
  { id: 'canvas_study_bridge', title: 'Canvas assignments and quizzes', threshold: 0.85 },
  { id: 'creative_asset_router', title: 'Collect design downloads', threshold: 0.85 },
  { id: 'inline_unit_camera_calc', title: 'Answer unit math while you type', threshold: 0.85 },
] as const;

export type MovesMap = Record<string, { status?: string; threshold?: number }>;

/** Moves map with every seed present (status "new" until reviewed). */
export function withSeeds(moves: MovesMap = {}): MovesMap {
  const out = { ...moves };
  for (const s of SEEDS) if (!out[s.id]) out[s.id] = { status: 'new', threshold: s.threshold };
  return out;
}

export const isEnabled = (moves: MovesMap | undefined, id: string): boolean => moves?.[id]?.status === 'enabled';
export const thresholdOf = (moves: MovesMap | undefined, id: string): number => moves?.[id]?.threshold ?? 0.85;

// ---- compact workflow state ----
const canvasHostOf = (h: string, extra?: string) => /(^|\.)instructure\.com$/.test(h) || (!!extra && h === String(extra).toLowerCase());
const canvasPath = (p: string) => p.replace(/\/(courses|assignments|quizzes|items)\/\d+/g, '/$1/:id');
const hostPath = (host: string | undefined, path: string | undefined, canvasHost?: string) => {
  const h = (host || '').toLowerCase().replace(/^www\./, '');
  const p = (path || '/').toLowerCase();
  return canvasHostOf(h, canvasHost) ? 'canvas' + canvasPath(p).slice(0, 40) : h + p.slice(0, 40);
};

export function compactEvent(ev: RingEvent | null | undefined, canvasHost?: string): string {
  if (!ev) return '';
  if (ev.kind === 'download') return 'dl:' + String(ev.name || '').split(/[\\/]/).pop()!.toLowerCase().slice(0, 40);
  if (ev.engine && ev.query) return `${ev.engine}:q=${ev.query.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 60)}`;
  return hostPath(ev.host, ev.path, canvasHost);
}

export function compactUrl(url: string, canvasHost?: string): string {
  const s = parseSearch(url);
  if (s) return compactEvent({ kind: 'visit', t: 0, ...s });
  try {
    const u = new URL(url);
    return compactEvent({ kind: 'visit', t: 0, host: u.hostname, path: u.pathname }, canvasHost);
  } catch {
    return String(url).slice(0, 40);
  }
}

/** The last 5 events, oldest first, as compact strings. */
export const compactState = (ring: RingEvent[], canvasHost?: string): string[] => ring.slice(-5).map((e) => compactEvent(e, canvasHost));
