// Nightly trainer: Visit[] + TypedInput[] -> PredictionSnapshot. Pure and deterministic.
// Ports helper/pattern_miner.py (aliases, sequences) and tools/train.py (classifier) from Lifeboard.
import type { PredictionSnapshot, TypedInput, Visit } from '../history-types.ts';
import { trainClassifier } from './classifier.ts';
import type { Labeled } from './classifier.ts';
import { isSSO } from './moves.ts';
import { DEFAULT_PARAMS, resolveParams } from './params.ts';
import type { PredictParams } from '../history-types.ts';

type Site = PredictionSnapshot['sites'][number];

export const SITE_CAP = 5000;
export const HALF_LIFE_DAYS = DEFAULT_PARAMS.halfLifeDays;
const DAY = 86400000;

// ---- URL normalisation ----
const urlCache = new Map<string, string>();

/** Strips the hash and tracking params (utm_*, fbclid, gclid). Also trims a lone trailing "?" . */
export function normalizeUrl(raw: string): string {
  const hit = urlCache.get(raw);
  if (hit !== undefined) return hit;
  let out: string;
  try {
    const u = new URL(raw);
    u.hash = '';
    if (u.search) {
      for (const k of [...u.searchParams.keys()]) if (/^utm_/i.test(k) || k === 'fbclid' || k === 'gclid') u.searchParams.delete(k);
    }
    out = u.toString();
  } catch {
    const i = raw.indexOf('#');
    out = i < 0 ? raw : raw.slice(0, i);
  }
  if (urlCache.size > 200000) urlCache.clear();
  urlCache.set(raw, out);
  return out;
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}
const hostOfUrl = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
};

/** Frecency weight by how the page was reached. */
export function transitionWeight(t: Visit['transition'], p: PredictParams = DEFAULT_PARAMS): number {
  switch (t) {
    case 'typed': return p.wTyped;
    case 'link': return p.wLink;
    case 'search': return p.wSearch;
    case 'reload': return 0;
    case 'redirect': return 0;
    default: return p.wOther; // 'other' (bookmarks, imports with unknown transition)
  }
}

// ---- search engines / helpers from pattern_miner.py ----
const isEngine = (host: string) => host.startsWith('google.') || host === 'duckduckgo.com' || host === 'bing.com';

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] !== b[j - 1] ? 1 : 0)));
    prev = cur;
  }
  return prev[b.length];
}

// What a typed site name usually means. A match is a host test: "=x" exact (after www.), ".x" suffix,
// "x." prefix, "~x" substring.
export const KNOWN_TARGETS: Record<string, string> = {
  'eagles nest': '~eaglesnest', 'google drive': '=drive.google.com', drive: '=drive.google.com',
  'google docs': '=docs.google.com', calendar: '=calendar.google.com',
  cloudflare: '=dash.cloudflare.com', claudflare: '=dash.cloudflare.com',
  pinterest: '.pinterest.com', pintrest: '.pinterest.com', pintr: '.pinterest.com',
  canvas: '.instructure.com', 'google messages': '=messages.google.com',
  keep: '=keep.google.com', 'google keep': '=keep.google.com', outlook: 'outlook.',
  vercel: '.vercel.com', github: '.github.com', claude: '.claude.ai',
  gemini: '=gemini.google.com', chatgpt: '.chatgpt.com',
};

function hostMatches(host: string, rule: string): boolean {
  const kind = rule[0], x = rule.slice(1);
  if (kind === '=') return host === x;
  if (kind === '.') return host === x || host.endsWith(rule);
  if (kind === '~') return host.includes(x);
  return host.startsWith(rule);
}

function knownRule(variant: string): string | null {
  if (Object.prototype.hasOwnProperty.call(KNOWN_TARGETS, variant)) return KNOWN_TARGETS[variant];
  let best: [number, string] | null = null;
  for (const k of Object.keys(KNOWN_TARGETS)) {
    if (k.length <= 5) continue;
    const d = editDistance(variant, k);
    if (d <= 2 && (!best || d < best[0] || (d === best[0] && k < best[1]))) best = [d, k];
  }
  return best ? KNOWN_TARGETS[best[1]] : null;
}

const GENERIC_LABELS = new Set(['www', 'com', 'org', 'net', 'edu', 'gov', 'io', 'co', 'app', 'ai', 'dev', 'google', 'the']);

/** True if the search looks like the site's name ("google dive" -> drive.google.com), or the known-site table says so. */
export function namesHost(q: string, host: string): boolean {
  const labels = host.split(/[.-]/).filter((l) => l.length >= 3 && !GENERIC_LABELS.has(l));
  const words = q.split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !GENERIC_LABELS.has(w));
  const squashed = words.join('');
  const cand = words.length > 1 ? [...words, squashed] : words;
  for (const w of cand) {
    for (const l of labels) {
      if (editDistance(w, l) <= (Math.min(w.length, l.length) <= 5 ? 1 : 2) || (w.length >= 4 && l.includes(w))) return true;
    }
  }
  const rule = knownRule(q);
  return !!rule && hostMatches(host, rule);
}

interface Ev {
  t: number; // seconds
  host: string;
  url: string;
  q: string; // normalized search query or ''
}

// ---- aliases ----
function mineAliases(events: Ev[], originByHost: Map<string, string>, p: PredictParams): Record<string, string> {
  const pairs = new Map<string, number>(); // "q\u0000host" -> n, insertion ordered
  for (let i = 0; i < events.length; i++) {
    const q = events[i].q;
    if (!q || q.length > 40 || q.split(' ').length > 4) continue;
    for (let j = i + 1; j < events.length; j++) {
      const f = events[j];
      if (f.t - events[i].t > p.aliasWindowSec) break;
      if (!isEngine(f.host)) {
        if (namesHost(q, f.host)) {
          const k = q + '\u0000' + f.host;
          pairs.set(k, (pairs.get(k) || 0) + 1);
        }
        break;
      }
    }
  }
  const best = new Map<string, [string, number]>();
  for (const [k, n] of pairs) {
    const [q, host] = k.split('\u0000');
    if (n >= p.aliasMinCount && n > (best.get(q)?.[1] ?? 0)) best.set(q, [host, n]);
  }
  const out: Record<string, string> = {};
  for (const [q, [host]] of best) out[q] = originByHost.get(host) || 'https://' + host;
  return out;
}

const normText = (s: string) => s.toLowerCase().trim().replace(/\s+/g, ' ');

/** typed text -> url: accepted suggestions, or the same text going to the same url 2+ times. */
function typedAliases(typed: TypedInput[], p: PredictParams): Record<string, string> {
  const per = new Map<string, Map<string, { n: number; acc: number }>>();
  for (const ti of typed) {
    const text = normText(ti.text || '');
    if (!text || text.length > 40 || text.split(' ').length > 4 || text[0] === '!' || /[./:]/.test(text)) continue;
    const raw = ti.accepted ? ti.shownUrl || ti.url : ti.url;
    if (!raw) continue;
    const url = normalizeUrl(raw);
    const host = hostOfUrl(url);
    if (!host || isEngine(host) || isSSO(host, new URL(url).pathname)) continue;
    let m = per.get(text);
    if (!m) per.set(text, (m = new Map()));
    const e = m.get(url) || { n: 0, acc: 0 };
    e.n++;
    if (ti.accepted) e.acc++;
    m.set(url, e);
  }
  const out: Record<string, string> = {};
  for (const [text, m] of per) {
    let best: [string, number] | null = null;
    for (const [url, e] of m) {
      if (e.acc < 1 && e.n < p.aliasMinCount) continue;
      const score = e.n + e.acc;
      if (!best || score > best[1] || (score === best[1] && url < best[0])) best = [url, score];
    }
    if (best) out[text] = best[0];
  }
  return out;
}

// ---- sequences ----
const dayKey = (tSec: number) => {
  const d = new Date(tSec * 1000);
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
};

function mineSequences(events: Ev[]): { hosts: [string, string, string]; n: number; days: number }[] {
  const seq: Ev[] = [];
  for (const e of events) {
    if (isEngine(e.host)) continue;
    if (seq.length && seq[seq.length - 1].host === e.host) continue;
    seq.push(e);
  }
  const n = new Map<string, number>();
  const days = new Map<string, Set<number>>();
  for (let i = 0; i + 2 < seq.length; i++) {
    const a = seq[i], b = seq[i + 1], c = seq[i + 2];
    if (a.host === c.host || a.host === b.host || b.host === c.host) continue;
    if (c.t - a.t > 600) continue;
    const k = a.host + '\u0000' + b.host + '\u0000' + c.host;
    n.set(k, (n.get(k) || 0) + 1);
    let s = days.get(k);
    if (!s) days.set(k, (s = new Set()));
    s.add(dayKey(a.t));
  }
  const rows = [...n].filter(([k, v]) => v >= 4 && days.get(k)!.size >= 3);
  rows.sort((x, y) => y[1] - x[1]); // stable: ties keep first-seen order
  return rows.slice(0, 20).map(([k, v]) => {
    const h = k.split('\u0000');
    return { hosts: [h[0], h[1], h[2]] as [string, string, string], n: v, days: days.get(k)!.size };
  });
}

export interface TrainOptions {
  /** Router corrections ({text, cls}); count 3x in the classifier retrain. */
  corrections?: Labeled[];
  /** Tunable knobs (defaults = original behaviour). Stored in snapshot.params. */
  params?: Partial<PredictParams>;
}

/**
 * Builds the prediction snapshot from history. `now` is epoch ms (pass it in: the function never reads the clock).
 * `prev` is only used to keep the previous classifier when there are no corrections to retrain with.
 */
export function train(visits: Visit[], typed: TypedInput[], now: number, prev?: PredictionSnapshot | null, opts: TrainOptions = {}): PredictionSnapshot {
  const P = resolveParams(opts.params);
  // 1. frecency per normalized URL
  const sites = new Map<string, Site & { titleT: number }>();
  const mkSite = (url: string, host: string): Site & { titleT: number } => ({ url, host, title: '', score: 0, visits: 0, typed: 0, lastT: 0, titleT: -1 });
  for (const v of visits) {
    if (v.query) continue; // search-result pages are not destinations
    const w = transitionWeight(v.transition, P);
    const url = normalizeUrl(v.url);
    let s = sites.get(url);
    if (!s) sites.set(url, (s = mkSite(url, v.host || hostOfUrl(url))));
    if (w > 0) s.score += w * Math.pow(0.5, Math.max(0, now - v.t) / DAY / P.halfLifeDays);
    s.visits++;
    if (v.transition === 'typed') s.typed++;
    if (v.t > s.lastT) s.lastT = v.t;
    if (v.title && v.t >= s.titleT) {
      s.title = v.title;
      s.titleT = v.t;
    }
  }
  for (const ti of typed) {
    if (!ti.accepted) continue;
    const raw = ti.shownUrl || ti.url;
    if (!raw) continue;
    const url = normalizeUrl(raw);
    let s = sites.get(url);
    if (!s) sites.set(url, (s = mkSite(url, hostOfUrl(url))));
    s.score += P.acceptedBonus;
    s.typed++;
    if (ti.t > s.lastT) s.lastT = ti.t;
  }
  const ranked: Site[] = [];
  for (const s of sites.values()) {
    if (s.score <= 0) continue;
    const { titleT: _t, ...site } = s;
    site.score = Math.round(site.score * 1e4) / 1e4;
    ranked.push(site);
  }
  ranked.sort((a, b) => b.score - a.score || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  const top = ranked.slice(0, SITE_CAP);

  // 2. events for mining: SSO pages dropped so A -> login -> B counts as A -> B
  const events: Ev[] = [];
  const originCount = new Map<string, Map<string, number>>();
  const sorted = visits.filter((v) => v.t > 0).sort((a, b) => a.t - b.t);
  for (const v of sorted) {
    const host = (v.host || hostOfUrl(v.url)).toLowerCase().replace(/^www\./, '');
    if (!host || isSSO(host, v.path || '/')) continue;
    if (v.transition === 'reload' || v.transition === 'redirect') continue;
    events.push({ t: v.t / 1000, host, url: v.url, q: v.query ? v.query.toLowerCase().split(/\s+/).filter(Boolean).join(' ').slice(0, 200) : '' });
    if (!v.query) {
      let c = originCount.get(host);
      if (!c) originCount.set(host, (c = new Map()));
      const o = originOf(v.url);
      c.set(o, (c.get(o) || 0) + 1);
    }
  }
  const originByHost = new Map<string, string>();
  for (const [h, c] of originCount) {
    let best: [string, number] | null = null;
    for (const [o, n] of c) if (!best || n > best[1]) best = [o, n];
    if (best) originByHost.set(h, best[0]);
  }

  // 3. aliases: mined from search -> site, then typed text -> url (typed wins)
  const aliases = { ...mineAliases(events, originByHost, P), ...typedAliases(typed, P) };

  // 4. sequences
  const bestUrl = new Map<string, string>();
  for (const s of top) if (!bestUrl.has(s.host)) bestUrl.set(s.host, s.url);
  const sequences = mineSequences(events).map((s) => ({
    ...s,
    url: bestUrl.get(s.hosts[2]) || originByHost.get(s.hosts[2]) || 'https://' + s.hosts[2],
    label: `Open ${s.hosts[2]}`,
  }));

  // 5. hourly / weekday histograms for the hosts we keep
  const keep = new Set(top.map((s) => s.host));
  const hourly: Record<string, number[]> = {};
  const weekday: Record<string, number[]> = {};
  for (const v of visits) {
    if (v.query || transitionWeight(v.transition, P) <= 0) continue;
    const host = (v.host || hostOfUrl(v.url)).toLowerCase().replace(/^www\./, '');
    if (!keep.has(host)) continue;
    const d = new Date(v.t);
    (hourly[host] ||= new Array(24).fill(0))[d.getHours()]++;
    (weekday[host] ||= new Array(7).fill(0))[d.getDay()]++;
  }

  // 6. classifier: retrain when there are corrections, else keep what we had (or the bundled weights)
  let classifier: unknown = prev?.classifier;
  if (opts.corrections && opts.corrections.length) classifier = trainClassifier(opts.corrections);

  const snap: PredictionSnapshot = { version: 1, trainedAt: now, sites: top, aliases, sequences, hourly, weekday, params: P };
  if (classifier !== undefined) snap.classifier = classifier;
  return snap;
}
