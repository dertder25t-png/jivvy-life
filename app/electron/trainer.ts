// Nightly training (main process side). The heavy work (shared/lifeboard train(), ~0.5 s per 50k
// visits) runs in a worker thread so the UI never stalls. The result is <userData>/predictions.json
// (mode 0600, written atomically) and is pushed to the UI views through `onUpdate`.
//
// Schedule: shortly after launch if the snapshot is missing or older than 20 h, daily at 03:30 local
// while the app runs, and whenever the caller asks (after a Firefox import, after clearing history).
import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import type { UiSnapshot } from '../shared/history-types';
import { compactSnapshot, readSnapshotFile, validSnapshot } from './snapshot';
import { parseLog } from '../shared/lifeboard/evallog';
import type { EvalLine } from '../shared/lifeboard/evallog';
import type { BenchResult } from '../shared/lifeboard/bench';
import type { HistoryStore } from './history';
import { RETENTION_DAYS } from './history';
import { lagOp } from './lagmon';

const log = (...a: unknown[]) => console.error('[trainer]', ...a);

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const STALE_MS = 20 * HOUR;
export const STARTUP_DELAY_MS = 60_000;
const TIMEOUT_MS = 120_000;
const MAX_TIMER = 2 ** 31 - 1;

export { validSnapshot };

/** Next 03:30 local time strictly after `from`. */
export function next0330(from: number): number {
  const d = new Date(from);
  d.setHours(3, 30, 0, 0);
  if (d.getTime() <= from) d.setDate(d.getDate() + 1);
  return d.getTime();
}

export class Trainer {
  /** The compact snapshot the UI gets (full one lives in predictions.json). */
  snapshot: UiSnapshot | null = null;
  private running: Promise<UiSnapshot | null> | null = null;
  private timers: NodeJS.Timeout[] = [];
  readonly file: string;
  readonly evalFile: string;

  constructor(
    private dir: string,
    private history: HistoryStore,
    private onUpdate: (s: UiSnapshot | null) => void,
    /** Absolute path of the bundled worker entry. */
    private workerFile: string = path.join(__dirname, 'trainer-worker.js')
  ) {
    this.file = path.join(dir, 'predictions.json');
    this.evalFile = path.join(dir, 'predictions-eval.jsonl');
  }

  /** True while a training run is in flight. */
  get busy() {
    return !!this.running;
  }

  /** Read predictions.json (if any). Call once at startup. */
  load(): UiSnapshot | null {
    const full = readSnapshotFile(this.file);
    this.snapshot = full ? compactSnapshot(full) : null;
    return this.snapshot;
  }

  /** Start the schedule: stale-at-launch check, then the daily 03:30 job. */
  start(now = Date.now(), startDelayMs = STARTUP_DELAY_MS) {
    if (!this.snapshot || now - this.snapshot.trainedAt > STALE_MS) this.later(startDelayMs, () => void this.train());
    this.armNightly(now);
  }

  stop() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  private later(ms: number, fn: () => void) {
    const t = setTimeout(fn, Math.min(ms, MAX_TIMER));
    t.unref();
    this.timers.push(t);
  }

  private armNightly(now: number) {
    this.later(next0330(now) - now, () => {
      void this.train();
      this.armNightly(Date.now() + 1000);
    });
  }

  /** Train now. Concurrent calls share one run. Resolves with the new compact snapshot, or null on failure. */
  train(forceTune = false): Promise<UiSnapshot | null> {
    if (this.running) return this.running;
    this.running = this.run(forceTune).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async run(forceTune: boolean): Promise<UiSnapshot | null> {
    const endOp = lagOp('train');
    const now = Date.now();
    const t0 = performance.now();
    try {
      // self-tune about once a night (or when asked, e.g. after an import)
      const tune = forceTune || !this.snapshot?.eval || now - this.snapshot.eval.t > STALE_MS;
      const res = await this.inWorker({ kind: 'train', ...this.job(now), tune });
      if (!res.ui || !res.summary) throw new Error('bad worker result');
      const snap = res.ui;
      this.snapshot = snap;
      const sm = res.summary;
      log(`trained on ${sm.visits} visits, ${sm.typed} typed: ${sm.sites} sites, ${sm.aliases} shortcuts (${Math.round(performance.now() - t0)} ms${snap.eval && tune ? `, tuning ${snap.eval.status} in ${snap.eval.tuneMs} ms` : ''})`);
      this.onUpdate(snap); // once per training
      return snap;
    } catch (e) {
      log('training failed:', String(e instanceof Error ? e.message : e).slice(0, 200));
      return null;
    } finally {
      endOp();
    }
  }

  private job(now: number) {
    return { dbFile: this.history.file, predFile: this.file, evalFile: this.evalFile, since: now - RETENTION_DAYS * DAY, now };
  }

  /** Run the search benchmark on the live history (worker thread). Null on failure. */
  async bench(): Promise<BenchResult | null> {
    try {
      const res = await this.inWorker({ kind: 'bench', ...this.job(Date.now()) });
      return (res.bench as BenchResult) ?? null;
    } catch (e) {
      log('benchmark failed:', String(e instanceof Error ? e.message : e).slice(0, 200));
      return null;
    }
  }

  /** Lines of predictions-eval.jsonl (the Settings sparkline). */
  readLog(): EvalLine[] {
    try {
      return parseLog(fs.readFileSync(this.evalFile, 'utf8'));
    } catch {
      return [];
    }
  }

  private inWorker(job: unknown): Promise<WorkerResult> {
    return new Promise((resolve, reject) => {
      const w = new Worker(this.workerFile, { workerData: job });
      const timer = setTimeout(() => {
        void w.terminate();
        reject(new Error('timed out'));
      }, TIMEOUT_MS);
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void w.terminate();
        fn();
      };
      w.once('message', (m: WorkerResult) => done(() => (m.ok ? resolve(m) : reject(new Error(m.error || 'bad worker result')))));
      w.once('error', (e) => done(() => reject(e)));
      w.once('exit', (code) => done(() => reject(new Error(`worker exited (${code})`))));
    });
  }
}

interface WorkerResult {
  ok: boolean;
  ui?: UiSnapshot;
  summary?: { visits: number; typed: number; sites: number; aliases: number; ms: number };
  bench?: unknown;
  error?: string;
}
