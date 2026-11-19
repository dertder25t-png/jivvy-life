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
}
