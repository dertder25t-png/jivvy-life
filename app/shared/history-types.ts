// Shared contract between the history store (electron/history.ts, main process)
// and the pure prediction/training code (shared/lifeboard/*). Keep it small and stable.

export type Transition = 'typed' | 'link' | 'search' | 'reload' | 'redirect' | 'other';

/** One page visit recorded by the app (or imported from Firefox). Times are epoch ms. */
export interface Visit {
  url: string;
  host: string; // lowercase, no "www."
  path: string;
  title: string;
  t: number;
  transition: Transition;
  /** Set when this visit is a search-results page (Google/DDG/Bing). */
  query?: string;
  engine?: 'google' | 'duckduckgo' | 'bing';
  /** How long the page stayed in front, if known. */
  dwellMs?: number;
}

/** What the user typed in the address bar / dashboard box and where they ended up. */
export interface TypedInput {
  text: string;
  url: string; // final URL opened ('' if they searched instead)
  shownUrl?: string; // the suggestion we showed, if any
  accepted: boolean; // true if they took our suggestion
  t: number;
}

/** Tunable knobs of train() and complete(). Defaults (lifeboard/params.ts) reproduce the original behaviour. */
export interface PredictParams {
  halfLifeDays: number;
  wTyped: number;
  wLink: number;
  wSearch: number;
  wOther: number;
  /** Frecency added per accepted address-bar suggestion. */
  acceptedBonus: number;
  /** Time-of-day boost strength: score x (1 + hourBoost x share of visits within the hour +-1). */
  hourBoost: number;
  aliasMinCount: number;
  aliasWindowSec: number;
  /** Inline-fill rule: fill the rest of the top host only once at least this many characters are typed. */
  inlineMinChars: number;
}

/** Search-accuracy numbers from shared/lifeboard/evaluate.ts. Rates are 0..1 (keystrokesSavedPct is 0..100). */
export interface EvalMetrics {
  n: number;
  mode: 'typed' | 'link-session';
  top1: [number, number, number];
  top3: [number, number, number];
  meanCharsToTop1: number;
  keystrokesSavedPct: number;
  wrongInlineRate: number;
  aliasPrecision: number | null;
  aliasN: number;
  p95Ms: number;
  trainMs: number;
}

/** Result of the last self-evaluation / tuning pass, stored in the snapshot. */
export interface SnapshotEval {
  t: number;
  status: 'promoted' | 'kept' | 'insufficient';
  mode: 'typed' | 'link-session';
  n: number;
  /** Metrics of the params actually used for the final snapshot (validation window). */
  metrics: EvalMetrics | null;
  /** Metrics of the previously used params, when a candidate was promoted. */
  previous: EvalMetrics | null;
  /** Human-readable param changes, e.g. ["halfLifeDays 14 -> 7"]. */
  changed: string[];
  tuneMs: number;
  /** top3@2chars change vs ~7 nights ago (null when there is no such night yet). */
  trend: number | null;
  alert?: boolean;
  message?: string;
}

/** Output of nightly training: one JSON snapshot loaded at startup. */
export interface PredictionSnapshot {
  version: 1;
  trainedAt: number;
  /** Per-URL frecency, highest first (capped, e.g. 5000). */
  sites: { url: string; host: string; title: string; score: number; visits: number; typed: number; lastT: number }[];
  /** Learned "typed text -> site" shortcuts (Lifeboard navAliases). */
  aliases: Record<string, string>;
  /** Learned 3-site sequences (Lifeboard discovered moves). */
  sequences: { hosts: [string, string, string]; url: string; n: number; days: number; label: string }[];
  /** Per-host visit counts by hour (0-23) and weekday (0-6). */
  hourly: Record<string, number[]>;
  weekday: Record<string, number[]>;
  /** Google-vs-AI router classifier weights (Lifeboard weights.json format), retrained nightly. */
  classifier?: unknown;
  /** The params this snapshot was trained with (complete() falls back to the defaults when absent). */
  params?: PredictParams;
  /** Result of the last nightly self-evaluation. */
  eval?: SnapshotEval;
}
