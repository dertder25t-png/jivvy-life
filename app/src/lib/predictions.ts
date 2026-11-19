// The nightly prediction snapshot as seen by the UI, plus the ported Lifeboard router/completer
// bound to it. Electron only: main trains (electron/trainer.ts) and pushes snapshots here; in
// other shells the snapshot stays null and everything falls back to bundled defaults.
import { useSyncExternalStore } from 'react';
import { complete, decide, DEFAULT_CONFIG } from '../../shared/lifeboard';
import type { Completion, Decision } from '../../shared/lifeboard';
import type { UiSnapshot, Visit } from '../../shared/history-types';
import { jivvy } from '../platform';
import { codeDecision, type CodeMode, type DashCls, type DashDecision, type RouteId } from './router';

let snapshot: UiSnapshot | null = null;
const subs = new Set<() => void>();
let started = false;

function set(s: UiSnapshot | null) {
  snapshot = s;
  subs.forEach((f) => f());
}

function start() {
  if (started || !jivvy) return;
  started = true;
  jivvy.onPredictions(set);
  void jivvy.predictions().then(set, () => undefined);
}

export function getPredictions(): UiSnapshot | null {
  start();
  return snapshot;
}

export function usePredictions(): UiSnapshot | null {
  start();
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => snapshot
  );
}

/** Router decision with the learned shortcuts and classifier. */
export function route(text: string, snap: UiSnapshot | null = getPredictions()): Decision | null {
  return decide(text, DEFAULT_CONFIG, snap);
}

export function suggest(text: string, snap: UiSnapshot | null = getPredictions(), recent?: Visit[]): Completion {
  return complete(text, snap, recent);
}

/** Where to send a decision from a plain address box. Claude Code jobs have no terminal here: they go to Claude. */
export function destination(d: Decision): { url: string; label: string } {
  if (d.url) return { url: d.url, label: d.label };
  return { url: `https://claude.ai/new?q=${encodeURIComponent(d.text)}`, label: 'Claude' };
}

/** Records what was typed and where it led (Electron main stores it locally; no-op elsewhere). */
export function recordTyped(i: { text: string; url: string; shownUrl?: string; accepted: boolean }) {
  if (!jivvy) return;
  const text = i.text.trim().slice(0, 200);
  // Long prompts are not shortcuts; keep only address-like or short lookups.
  if (!text || (!i.url && !i.shownUrl && text.split(/\s+/).length > 4)) return;
  jivvy.historyTyped({ text, url: i.url, shownUrl: i.shownUrl, accepted: i.accepted });
}

// ---- Dashboard box adapter -----------------------------------------------------------------
/** Ported Lifeboard Decision -> the dashboard's DashDecision (Claude Code jobs stay a copied terminal command). */
export function toDash(d: Decision | null): DashDecision | null {
  if (!d) return null;
  if (d.route === 'claude-code') return { ...codeDecision(d.text, d.why, d.source, d.mode as CodeMode | undefined), confidence: d.confidence };
  const cls: DashCls = d.route === 'open-url' ? 'url' : d.cls === 'code' ? 'code' : (d.cls ?? 'search');
  return { route: d.route as RouteId, label: d.label, cls, url: d.url ?? '', text: d.text, why: d.why, source: d.source, confidence: d.confidence, copy: d.copy, hint: d.hint };
}
