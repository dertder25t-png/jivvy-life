// Inline autocomplete for the address box (new; Lifeboard only had alias matching).
// Rank: host-prefix, then title-word prefix, then alias, then URL-path prefix; inside a tier by
// frecency (snapshot.sites) x a time-of-day boost. Built to stay well under 2 ms for 5,000 sites.
import type { PredictionSnapshot, Visit } from '../history-types.ts';
import { matchAlias } from './moves.ts';

export type SuggestionReason = 'host' | 'title' | 'alias' | 'path' | 'recent';
export interface Suggestion {
  url: string;
  title: string;
  host: string;
  reason: SuggestionReason;
}
export interface Completion {
  /** Text to append after what was typed (selected in the box). Only when the top host starts with the text. */
  inline?: string;
  url?: string;
  title?: string;
  suggestions: Suggestion[];
}

type Site = PredictionSnapshot['sites'][number];
interface Row {
  site: Site;
  host: string; // lowercase, no www
  title: string; // lowercase
  path: string; // lowercase "path?query" without leading slash, no scheme/host
  hk: string; // "." + host, for one-indexOf label-prefix tests
  tk: string; // " " + title with separators turned into spaces
  pk: string; // "/" + path
}
interface Index {
  rows: Row[];
  byHost: Map<string, Row>; // best-scoring row per host
  share: Map<string, number>; // hour-share cache, key "host|hour"
}

const MAX = 6;
const DAY = 86400000;
const cache = new WeakMap<object, Index>();

const bareHost = (h: string) => h.toLowerCase().replace(/^www\./, '');

function pathOf(url: string): string {
  const i = url.indexOf('//');
  const s = i < 0 ? url : url.slice(i + 2);
  const j = s.indexOf('/');
  return j < 0 ? '' : s.slice(j + 1).toLowerCase();
}

function toRow(site: Site): Row {
  const host = bareHost(site.host);
  const title = (site.title || '').toLowerCase();
  const path = pathOf(site.url);
  return { site, host, title, path, hk: '.' + host, tk: ' ' + title.replace(/[-_(\[|:,]+/g, ' '), pk: '/' + path };
}

function indexOf(snapshot: PredictionSnapshot): Index {
  let ix = cache.get(snapshot);
  if (ix) return ix;
  const rows = snapshot.sites.map(toRow);
  const byHost = new Map<string, Row>();
  for (const r of rows) {
    const b = byHost.get(r.host);
    if (!b || r.site.score > b.site.score) byHost.set(r.host, r);
  }
  ix = { rows, byHost, share: new Map() };
  cache.set(snapshot, ix);
  return ix;
}

/** Host starts with the text (1), or any label after a dot does (2): "can" -> canvas.school.edu, mail.canvas.com. */
function hostMatch(r: Row, t: string): 0 | 1 | 2 {
  if (r.hk.indexOf('.' + t) < 0) return 0;
  return r.host.startsWith(t) ? 1 : 2;
}

/** Every typed word is the start of some word in the title (typed words in any order). */
function titleMatch(r: Row, words: string[]): boolean {
  if (!r.title) return false;
  for (const w of words) if (r.tk.indexOf(' ' + w) < 0) return false;
  return true;
}

function pathMatch(r: Row, t: string): boolean {
  return r.pk.length > 1 && r.pk.indexOf('/' + t) >= 0;
}

/** Share of this host's visits within the hour +-1, 0..1. */
function hourShare(snapshot: PredictionSnapshot, host: string, hour: number, memo: Map<string, number>): number {
  const key = host + '|' + hour;
  let v = memo.get(key);
  if (v === undefined) memo.set(key, (v = hourShareRaw(snapshot, host, hour)));
  return v;
}

function hourShareRaw(snapshot: PredictionSnapshot, host: string, hour: number): number {
  const h = snapshot.hourly?.[host];
  if (!h || h.length < 24) return 0;
  let total = 0;
  for (let i = 0; i < 24; i++) total += h[i] || 0;
  if (!total) return 0;
  return ((h[(hour + 23) % 24] || 0) + (h[hour] || 0) + (h[(hour + 1) % 24] || 0)) / total;
}

/**
 * Suggestions for what's typed in the address box. `recentVisits` (since the last training) add a little
 * score so today's pages show up before the nightly job runs. `now` is injectable for tests.
 */
export function complete(text: string, snapshot: PredictionSnapshot | null | undefined, recentVisits?: Visit[], now: number = Date.now()): Completion {
  const empty: Completion = { suggestions: [] };
  if (!snapshot) return empty;
  let typed = text.replace(/^\s+/, '').toLowerCase();
  typed = typed.replace(/^https?:\/\//, '').replace(/^www\./, '');
  const t = typed.trim();
  if (!t) return empty;
  const hasSpace = /\s/.test(typed);
  const words = hasSpace ? t.split(/\s+/) : [t];
  const hour = new Date(now).getHours();
  const ix = indexOf(snapshot);

  // recent visits: extra frecency, keyed by url (and new rows for urls the snapshot has not seen yet)
  let extra: Map<string, number> | null = null;
  const extraRows: Row[] = [];
  if (recentVisits && recentVisits.length) {
    extra = new Map();
    const known = new Set<string>();
    for (const r of ix.rows) known.add(r.site.url);
    for (const v of recentVisits) {
      const w = v.transition === 'typed' ? 2 : v.transition === 'reload' || v.transition === 'redirect' || v.query ? 0 : v.transition === 'search' ? 0.3 : 1;
      if (!w) continue;
      const add = w * Math.pow(0.5, Math.max(0, now - v.t) / DAY / 14);
      extra.set(v.url, (extra.get(v.url) || 0) + add);
      if (!known.has(v.url)) {
        known.add(v.url);
        extraRows.push(toRow({ url: v.url, host: v.host, title: v.title, score: 0, visits: 0, typed: 0, lastT: v.t }));
      }
    }
  }

  const scoreOf = (r: Row): number => {
    const base = r.site.score + (extra ? extra.get(r.site.url) || 0 : 0);
    return base * (1 + 0.3 * hourShare(snapshot, r.site.host, hour, ix.share));
  };

  interface Cand {
    row: Row;
    tier: number;
    score: number;
    reason: SuggestionReason;
    hostStart: boolean;
  }
  const cands: Cand[] = [];
  const seenUrl = new Set<string>();
  const tierCount = [0, 0, 0, 0];
  const add = (row: Row, tier: number, reason: SuggestionReason, hostStart = false) => {
    if (seenUrl.has(row.site.url)) return;
    seenUrl.add(row.site.url);
    tierCount[tier]++;
    cands.push({ row, tier, score: scoreOf(row), reason, hostStart });
  };

  // snapshot.sites is sorted best-first, so the first CAP matches per tier are the ones worth ranking
  const CAP = 150;
  const scan = (rows: Row[], capped: boolean) => {
    for (let i = 0; i < rows.length; i++) {
      if (capped && tierCount[0] >= CAP && tierCount[1] >= CAP && tierCount[3] >= CAP) break;
      const r = rows[i];
      if (!hasSpace) {
        const m = hostMatch(r, t);
        if (m) {
          if (!capped || tierCount[0] < CAP) add(r, 0, 'host', m === 1);
          continue;
        }
      }
      if (titleMatch(r, words)) {
        if (!capped || tierCount[1] < CAP) add(r, 1, 'title');
        continue;
      }
      if (!hasSpace && pathMatch(r, t) && (!capped || tierCount[3] < CAP)) add(r, 3, 'path');
    }
  };
  scan(ix.rows, true);
  scan(extraRows, false);

  // alias tier: exact / <=2 typos (matchAlias), or the alias name starts with what is typed
  const aliases = snapshot.aliases || {};
  const hit = matchAlias(t, aliases);
  const aliasUrls: string[] = hit ? [hit.url] : [];
  if (!hasSpace && t.length >= 2) {
    for (const k in aliases) if (k.toLowerCase().startsWith(t) && aliases[k] && aliases[k] !== hit?.url) aliasUrls.push(aliases[k]);
  }
  for (const u of aliasUrls) {
    let host = '';
    try {
      host = bareHost(new URL(u).hostname);
    } catch {
      continue;
    }
    // prefer the row for the exact URL, else the user's best page on that host, else a bare row
    let row = ix.rows.find((r) => r.site.url === u) || ix.byHost.get(host);
    if (row && seenUrl.has(row.site.url)) {
      // already ranked in a higher tier: lift it to the alias tier only if it would otherwise rank lower
      const c = cands.find((x) => x.row === row);
      if (c && c.tier > 2) {
        c.tier = 2;
        c.reason = 'alias';
      }
      continue;
    }
    if (!row) row = toRow({ url: u, host, title: '', score: 0, visits: 0, typed: 0, lastT: 0 });
    add(row, 2, 'alias');
  }

  cands.sort((a, b) => a.tier - b.tier || b.score - a.score || (a.row.site.url < b.row.site.url ? -1 : 1));

  // one suggestion per host (path matches may show several pages of the same site once)
  const out: Suggestion[] = [];
  const hostSeen = new Set<string>();
  let top: Cand | undefined;
  for (const c of cands) {
    if (out.length >= MAX) break;
    if (c.tier < 3 && hostSeen.has(c.row.host)) continue;
    if (c.tier === 3 && hostSeen.has(c.row.host) && out.filter((s) => s.host === c.row.host).length >= 2) continue;
    hostSeen.add(c.row.host);
    if (!top) top = c;
    out.push({ url: c.row.site.url, title: c.row.site.title, host: c.row.host, reason: c.reason });
  }
  if (!top) return empty;

  const res: Completion = { suggestions: out, url: top.row.site.url, title: top.row.site.title };
  if (!hasSpace && top.tier === 0 && top.hostStart && top.row.host.length > t.length) res.inline = top.row.host.slice(t.length);
  return res;
}
