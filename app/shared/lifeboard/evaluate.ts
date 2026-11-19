// Replay benchmark for search / prediction. Pure: train on history before `splitAt`, then replay what the user
// did in [splitAt, now) and measure how well complete() would have predicted it as they typed.
// Everything except the two timing fields (p95Ms, trainMs) is deterministic.
import type { EvalMetrics, PredictParams, TypedInput, Visit } from '../history-types.ts';
import { complete } from './complete.ts';
import { resolveParams } from './params.ts';
import { matchAlias } from './moves.ts';
import { train } from './train.ts';

export const MIN_TARGETS = 30;
const SESSION_GAP = 30 * 60_000;
const MAX_STEPS = 8;
const RECENT_CAP = 300;

export interface EvalOptions {
  splitAt: number;
  now: number;
  /** Evaluate at most this many targets (evenly strided, deterministic). Keeps tuning inside its time budget. */
  maxTargets?: number;
}

interface Target {
  host: string;
  t: number;
}

const hostOf = (v: Visit): string => (v.host || '').toLowerCase().replace(/^www\./, '');
const urlHost = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
};
const normText = (s: string) => s.toLowerCase().trim().replace(/\s+/g, ' ');

/** Typed-navigation targets (typed visits + address-bar inputs), or link visits that open a new host session. */
export function findTargets(visits: Visit[], typed: TypedInput[], splitAt: number, now: number): { mode: EvalMetrics['mode']; targets: Target[] } {
  const sorted = visits.filter((v) => v.t > 0 && !v.query).sort((a, b) => a.t - b.t);
  const win: Visit[] = [];
  for (const v of sorted) if (v.t >= splitAt && v.t < now) win.push(v);
  const typedT: Target[] = [];
  for (const v of win) if (v.transition === 'typed' && hostOf(v)) typedT.push({ host: hostOf(v), t: v.t });
  for (const ti of typed) {
    if (ti.t < splitAt || ti.t >= now || !ti.url) continue;
    const host = urlHost(ti.url);
    if (!host) continue;
    // the same navigation is usually also a typed visit: do not count it twice
    if (typedT.some((x) => x.host === host && Math.abs(x.t - ti.t) <= 15_000)) continue;
    typedT.push({ host, t: ti.t });
  }
  if (typedT.length >= MIN_TARGETS) return { mode: 'typed', targets: typedT.sort((a, b) => a.t - b.t || (a.host < b.host ? -1 : 1)) };

  // fallback: links that start a new host session (all history counts for "previous 30 min")
  const lastSeen = new Map<string, number>();
  const link: Target[] = [];
  for (const v of sorted) {
    if (v.t >= now) break;
    const h = hostOf(v);
    if (!h) continue;
    const prev = lastSeen.get(h);
    if (v.t >= splitAt && v.transition === 'link' && (prev === undefined || v.t - prev > SESSION_GAP)) link.push({ host: h, t: v.t });
    lastSeen.set(h, v.t);
  }
  return { mode: 'link-session', targets: link };
}

const pct = (xs: number[], q: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))] : 0);
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

export function evaluate(visits: Visit[], typed: TypedInput[], params: Partial<PredictParams> | undefined, opts: EvalOptions): EvalMetrics {
  const { splitAt, now } = opts;
  const P = resolveParams(params);
  const t0 = performance.now();
  const snap = train(visits.filter((v) => v.t < splitAt), typed.filter((x) => x.t < splitAt), splitAt, null, { params: P });
  const trainMs = performance.now() - t0;

  const found = findTargets(visits, typed, splitAt, now);
  let targets = found.targets;
  const max = opts.maxTargets ?? 0;
  if (max > 0 && targets.length > max) {
    const step = targets.length / max;
    targets = Array.from({ length: max }, (_, i) => targets[Math.floor(i * step)]);
  }
  const win = visits.filter((v) => v.t >= splitAt && v.t < now && v.t > 0).sort((a, b) => a.t - b.t);

  const top1 = [0, 0, 0], top3 = [0, 0, 0];
  let charsSum = 0, savedSum = 0, wrongInline = 0, steps = 0;
  const lat: number[] = [];
  for (const tg of targets) {
    const label = tg.host.split('.')[0];
    const L = Math.min(label.length, MAX_STEPS);
    if (L === 0) continue;
    // replay context: window visits strictly before the target
    let lo = 0, hi = win.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (win[m].t < tg.t) lo = m + 1;
      else hi = m;
    }
    const recent = win.slice(Math.max(0, lo - RECENT_CAP), lo);
    let needed = 0;
    const at1: boolean[] = [], at3: boolean[] = [];
    for (let c = 1; c <= L; c++) {
      const text = label.slice(0, c);
      const s0 = performance.now();
      const res = complete(text, snap, recent, tg.t);
      lat.push(performance.now() - s0);
      const hosts = res.suggestions.map((s) => s.host);
      const ok1 = hosts[0] === tg.host;
      at1[c] = ok1;
      at3[c] = hosts.slice(0, 3).includes(tg.host);
      steps++;
      if (res.inline && text + res.inline !== tg.host) wrongInline++;
      if (ok1 && !needed) needed = c;
      if (needed && c >= Math.min(3, L)) break;
    }
    const found1 = needed > 0;
    if (!found1) needed = label.length; // never correct: the whole label (cap = full length)
    charsSum += needed;
    if (found1) savedSum += Math.max(0, (tg.host.length - needed) / tg.host.length);
    for (let k = 1; k <= 3; k++) {
      const c = Math.min(k, L); // fewer letters than k: the full label
      if (at1[c]) top1[k - 1]++;
      if (at3[c]) top3[k - 1]++;
    }
  }
  const n = targets.filter((tg) => tg.host.split('.')[0].length > 0).length;

  // alias precision: typed texts that match a learned alias should have gone where the alias points
  let aliasN = 0, aliasOk = 0;
  for (const ti of typed) {
    if (ti.t < splitAt || ti.t >= now || !ti.text) continue;
    const chosen = ti.accepted ? ti.shownUrl || ti.url : ti.url;
    if (!chosen) continue;
    const hit = matchAlias(normText(ti.text), snap.aliases);
    if (!hit) continue;
    aliasN++;
    if (urlHost(hit.url) === urlHost(chosen)) aliasOk++;
  }

  const d = n || 1;
  return {
    n,
    mode: found.mode,
    top1: top1.map((x) => r4(x / d)) as [number, number, number],
    top3: top3.map((x) => r4(x / d)) as [number, number, number],
    meanCharsToTop1: r4(charsSum / d),
    keystrokesSavedPct: r4((savedSum / d) * 100),
    wrongInlineRate: r4(steps ? wrongInline / steps : 0),
    aliasPrecision: aliasN ? r4(aliasOk / aliasN) : null,
    aliasN,
    p95Ms: Math.round(pct(lat, 0.95) * 1000) / 1000,
    trainMs: Math.round(trainMs),
  };
}

/** Tuning objective: top3@2chars + 0.5 * top1@2chars - wrongInlineRate. */
export const objective = (m: EvalMetrics): number => m.top3[1] + 0.5 * m.top1[1] - 1.0 * m.wrongInlineRate;

/** A candidate replaces the current params only for a clear gain that does not cost top-1 accuracy. */
export function shouldPromote(cur: EvalMetrics, cand: EvalMetrics): boolean {
  return objective(cand) >= objective(cur) + 0.01 && cand.top1[1] >= cur.top1[1] - 0.02;
}
