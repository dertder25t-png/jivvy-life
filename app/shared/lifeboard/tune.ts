// Nightly self-tuning: evaluate the current params and a few candidates on the last week of history
// (training only on what came before), promote one only on a clear, safe gain.
import type { EvalMetrics, PredictParams, SnapshotEval, TypedInput, Visit } from '../history-types.ts';
import { DEFAULT_PARAMS, resolveParams } from './params.ts';
import { evaluate, MIN_TARGETS, objective, shouldPromote } from './evaluate.ts';

const DAY = 86400000;
export const VALIDATION_DAYS = 7;
export const TUNE_BUDGET_MS = 20_000;
export const MAX_CANDIDATES = 15;

const GRID: { [K in 'halfLifeDays' | 'wTyped' | 'hourBoost']: number[] } = {
  halfLifeDays: [7, 14, 30],
  wTyped: [1.5, 2, 3],
  hourBoost: [0, 0.3, 0.6],
};

export interface TuneOptions {
  budgetMs?: number;
  /** Replace the generated candidate set (tests). */
  candidates?: Partial<PredictParams>[];
  maxTargets?: number;
  clock?: () => number;
}
export interface TuneResult {
  params: PredictParams;
  eval: Omit<SnapshotEval, 'trend' | 'alert' | 'message'>;
}

const sameParams = (a: PredictParams, b: PredictParams) => (Object.keys(DEFAULT_PARAMS) as (keyof PredictParams)[]).every((k) => a[k] === b[k]);

export function describeChange(from: PredictParams, to: PredictParams): string[] {
  return (Object.keys(DEFAULT_PARAMS) as (keyof PredictParams)[]).filter((k) => from[k] !== to[k]).map((k) => `${k} ${from[k]} -> ${to[k]}`);
}

/** One-at-a-time variations around `cur`, plus the defaults. */
export function generateCandidates(cur: PredictParams): PredictParams[] {
  const out: PredictParams[] = [DEFAULT_PARAMS];
  for (const k of Object.keys(GRID) as (keyof typeof GRID)[]) for (const v of GRID[k]) out.push({ ...cur, [k]: v });
  const seen: PredictParams[] = [];
  for (const c of out) if (!sameParams(c, cur) && !seen.some((s) => sameParams(s, c))) seen.push(c);
  return seen;
}

export function tune(visits: Visit[], typed: TypedInput[], now: number, currentParams: Partial<PredictParams> | undefined, opts: TuneOptions = {}): TuneResult {
  const clock = opts.clock ?? (() => performance.now());
  const start = clock();
  const budget = opts.budgetMs ?? TUNE_BUDGET_MS;
  const cur = resolveParams(currentParams);
  const ev = { splitAt: now - VALIDATION_DAYS * DAY, now, maxTargets: opts.maxTargets ?? 300 };
  const done = (status: SnapshotEval['status'], params: PredictParams, metrics: EvalMetrics, previous: EvalMetrics | null, extra = ''): TuneResult => ({
    params,
    eval: {
      t: now, status, mode: metrics.mode, n: metrics.n, metrics, previous,
      changed: status === 'promoted' ? describeChange(cur, params) : extra ? [extra] : [],
      tuneMs: Math.round(clock() - start),
    },
  });

  const base = evaluate(visits, typed, cur, ev);
  if (base.n < MIN_TARGETS) return done('insufficient', cur, base, null);

  const tried: { p: PredictParams; m: EvalMetrics }[] = [];
  const over = () => clock() - start > budget;
  const run = (p: PredictParams): boolean => {
    if (over()) return false;
    tried.push({ p, m: evaluate(visits, typed, p, ev) });
    return true;
  };

  const generated = !opts.candidates;
  const list = (opts.candidates ? opts.candidates.map(resolveParams) : generateCandidates(cur)).slice(0, MAX_CANDIDATES - 1);
  for (const c of list) {
    if (!run(c)) return done('kept', cur, base, null, 'tuning budget exhausted, kept current');
  }
  // best combination of the single-knob winners
  if (generated) {
    const combo = { ...cur };
    let changedKnobs = 0;
    for (const k of Object.keys(GRID) as (keyof typeof GRID)[]) {
      let best: { v: number; o: number } | null = null;
      for (const { p, m } of tried) {
        if (p[k] === cur[k] || !(Object.keys(GRID) as (keyof typeof GRID)[]).every((j) => j === k || p[j] === cur[j])) continue;
        const o = objective(m);
        if (o > objective(base) && (!best || o > best.o)) best = { v: p[k], o };
      }
      if (best) {
        combo[k] = best.v;
        changedKnobs++;
      }
    }
    if (changedKnobs >= 2 && !tried.some((t) => sameParams(t.p, combo)) && !run(combo)) return done('kept', cur, base, null, 'tuning budget exhausted, kept current');
  }

  let best: { p: PredictParams; m: EvalMetrics } | null = null;
  for (const t of tried) if (shouldPromote(base, t.m) && (!best || objective(t.m) > objective(best.m))) best = t;
  return best ? done('promoted', best.p, best.m, base) : done('kept', cur, base, null);
}
