// Runs train() off the main thread (see trainer.ts). One job per worker: input in, snapshot out.
import { parentPort, workerData } from 'node:worker_threads';
import { train } from '../shared/lifeboard';
import type { PredictionSnapshot, TypedInput, Visit } from '../shared/history-types';

interface Job {
  visits: Visit[];
  typed: TypedInput[];
  now: number;
  prev: PredictionSnapshot | null;
}

try {
  const j = workerData as Job;
  parentPort!.postMessage({ ok: true, snapshot: train(j.visits, j.typed, j.now, j.prev) });
} catch (e) {
  parentPort!.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) });
}
