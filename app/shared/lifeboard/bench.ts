// The search benchmark shared by `npm run bench:search`, the Settings button and tests:
// default params vs the params in use vs the params a tuning pass would pick, all on the last-week replay.
import type { EvalMetrics, PredictParams, TypedInput, Visit } from '../history-types.ts';
import { evaluate } from './evaluate.ts';
import { DEFAULT_PARAMS, resolveParams } from './params.ts';
import { tune, VALIDATION_DAYS } from './tune.ts';

const DAY = 86400000;
export interface BenchRow {
  label: string;
  metrics: EvalMetrics;
  params: PredictParams;
}
export interface BenchResult {
  rows: BenchRow[];
  /** What the tuning pass did: promoted / kept / insufficient, and the param changes. */
  tuning: { status: string; changed: string[]; tuneMs: number };
  visits: number;
  typed: number;
}

export function runBench(visits: Visit[], typed: TypedInput[], now: number, currentParams?: Partial<PredictParams> | null): BenchResult {
  const ev = { splitAt: now - VALIDATION_DAYS * DAY, now };
  const cur = resolveParams(currentParams);
  const rows: BenchRow[] = [{ label: 'default', params: DEFAULT_PARAMS, metrics: evaluate(visits, typed, DEFAULT_PARAMS, ev) }];
  const t = tune(visits, typed, now, cur);
  const same = JSON.stringify(cur) === JSON.stringify(DEFAULT_PARAMS);
  if (!same) rows.push({ label: 'current', params: cur, metrics: evaluate(visits, typed, cur, ev) });
  rows.push({ label: 'tuned', params: t.params, metrics: t.eval.metrics! });
  return { rows, tuning: { status: t.eval.status, changed: t.eval.changed, tuneMs: t.eval.tuneMs }, visits: visits.length, typed: typed.length };
}

const pc = (x: number) => (Math.round(x * 1000) / 10).toFixed(1) + '%';
export function formatBench(r: BenchResult): string {
  const head = ['params', 'n', 'mode', 'top1@1/2/3', 'top3@1/2/3', 'chars>top1', 'keys saved', 'wrong inline', 'alias prec', 'p95 ms', 'train ms'];
  const body = r.rows.map(({ label, metrics: m }) => [
    label, String(m.n), m.mode, m.top1.map((x) => Math.round(x * 100)).join('/') + '%', m.top3.map((x) => Math.round(x * 100)).join('/') + '%',
    m.meanCharsToTop1.toFixed(2), m.keystrokesSavedPct.toFixed(1) + '%', pc(m.wrongInlineRate), m.aliasPrecision === null ? 'n/a' : pc(m.aliasPrecision), m.p95Ms.toFixed(2), String(m.trainMs),
  ]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (c: string[]) => c.map((x, i) => x.padEnd(w[i])).join('  ');
  return [line(head), line(w.map((n) => '-'.repeat(n))), ...body.map(line)].join('\n');
}
