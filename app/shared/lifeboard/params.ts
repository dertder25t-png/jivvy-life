// Tunable knobs for train() and complete(). DEFAULT_PARAMS reproduces the behaviour before tuning existed.
import type { PredictParams } from '../history-types.ts';

export const DEFAULT_PARAMS: PredictParams = {
  halfLifeDays: 14,
  wTyped: 2,
  wLink: 1,
  wSearch: 0.3,
  wOther: 0.5,
  acceptedBonus: 1,
  hourBoost: 0.3,
  aliasMinCount: 2,
  aliasWindowSec: 60,
  inlineMinChars: 1,
};

/** Fill missing/invalid fields from the defaults (snapshots written by older builds have no params). */
export function resolveParams(p?: Partial<PredictParams> | null): PredictParams {
  if (!p) return DEFAULT_PARAMS;
  const out = { ...DEFAULT_PARAMS };
  for (const k of Object.keys(DEFAULT_PARAMS) as (keyof PredictParams)[]) {
    const v = p[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = v;
  }
  out.halfLifeDays = Math.min(365, Math.max(0.5, out.halfLifeDays)); // sane bounds, whatever a snapshot says
  return out;
}
