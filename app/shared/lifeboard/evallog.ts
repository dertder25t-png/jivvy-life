// predictions-eval.jsonl helpers: one JSON line per tuning run, newest last, capped.
import type { EvalMetrics, PredictParams } from '../history-types.ts';

export const EVAL_LOG_KEEP = 120;
export interface EvalLine {
  t: number;
  mode: string;
  n: number;
  status?: string;
  metrics: { current: EvalMetrics | null; chosen: EvalMetrics | null };
  promoted: boolean;
  params: PredictParams;
}

export function parseLog(text: string): EvalLine[] {
  const out: EvalLine[] = [];
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    try {
      const v = JSON.parse(l);
      if (v && typeof v.t === 'number') out.push(v);
    } catch { /* skip a damaged line */ }
  }
  return out;
}

export const appendLog = (lines: EvalLine[], line: EvalLine, keep = EVAL_LOG_KEEP): EvalLine[] => [...lines, line].slice(-keep);

const dayOf = (t: number) => {
  const d = new Date(t);
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
};
const top3at2 = (l: EvalLine): number | null => (l.n >= 30 && l.metrics.chosen ? l.metrics.chosen.top3[1] : null);

/** The last line of each night that has a real measurement, oldest first. */
export function nightly(lines: EvalLine[]): { t: number; v: number }[] {
  const by = new Map<number, { t: number; v: number }>();
  for (const l of lines) {
    const v = top3at2(l);
    if (v !== null) by.set(dayOf(l.t), { t: l.t, v });
  }
  return [...by.values()].sort((a, b) => a.t - b.t);
}

/** top3@2chars fell 3 nights in a row by more than 0.05 in total. */
export function regression(lines: EvalLine[]): { alert: boolean; message?: string } {
  const n = nightly(lines).slice(-4);
  if (n.length === 4 && n[1].v < n[0].v && n[2].v < n[1].v && n[3].v < n[2].v && n[0].v - n[3].v > 0.05) {
    return { alert: true, message: `Search accuracy has dropped 3 nights in a row: top-3 at 2 letters went from ${Math.round(n[0].v * 100)}% to ${Math.round(n[3].v * 100)}%.` };
  }
  return { alert: false };
}

/** Change in top3@2chars versus the night closest to 7 days before `now` (needs a night at least 5 days old). */
export function trend(lines: EvalLine[], now: number): number | null {
  const n = nightly(lines);
  const cur = n[n.length - 1];
  if (!cur) return null;
  const target = now - 7 * 86400000;
  let ref: { t: number; v: number } | null = null;
  for (const x of n) if (x.t <= now - 5 * 86400000 && (!ref || Math.abs(x.t - target) < Math.abs(ref.t - target))) ref = x;
  return ref ? Math.round((cur.v - ref.v) * 1e4) / 1e4 : null;
}
