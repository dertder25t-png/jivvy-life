// Runs train() (and the nightly self-tune / benchmark) off the main thread (see trainer.ts). One job per worker.
import { parentPort, workerData } from 'node:worker_threads';
import { train, tune, runBench } from '../shared/lifeboard';
import type { PredictionSnapshot, TypedInput, Visit } from '../shared/history-types';

interface Job {
  kind?: 'train' | 'bench';
  visits: Visit[];
  typed: TypedInput[];
  now: number;
  prev: PredictionSnapshot | null;
  /** Run the self-tune before the final training. */
  tune?: boolean;
}

try {
  const j = workerData as Job;
  if (j.kind === 'bench') {
    parentPort!.postMessage({ ok: true, bench: runBench(j.visits, j.typed, j.now, j.prev?.params) });
  } else {
    let params = j.prev?.params;
    let evalPart = j.prev?.eval;
    let line: unknown = null;
    if (j.tune) {
      const r = tune(j.visits, j.typed, j.now, params);
      params = r.params;
      evalPart = { ...r.eval, trend: null };
      line = {
        t: j.now, mode: r.eval.mode, n: r.eval.n, status: r.eval.status,
        metrics: { current: r.eval.previous ?? r.eval.metrics, chosen: r.eval.metrics },
        promoted: r.eval.status === 'promoted', params: r.params,
      };
    }
    // the FINAL snapshot always trains on all visits with the chosen params
    const snapshot = train(j.visits, j.typed, j.now, j.prev, { params });
    if (evalPart) snapshot.eval = evalPart;
    parentPort!.postMessage({ ok: true, snapshot, line });
  }
} catch (e) {
  parentPort!.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) });
}
