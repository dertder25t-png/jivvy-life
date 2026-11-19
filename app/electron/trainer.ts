// Nightly training (main process side). The heavy work (shared/lifeboard train(), ~0.5 s per 50k
// visits) runs in a worker thread so the UI never stalls. The result is <userData>/predictions.json
// (mode 0600, written atomically) and is pushed to the UI views through `onUpdate`.
//
// Schedule: shortly after launch if the snapshot is missing or older than 20 h, daily at 03:30 local
// while the app runs, and whenever the caller asks (after a Firefox import, after clearing history).
import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import type { PredictionSnapshot } from '../shared/history-types';
import { appendLog, parseLog, regression, trend } from '../shared/lifeboard/evallog';
import type { EvalLine } from '../shared/lifeboard/evallog';
import type { BenchResult } from '../shared/lifeboard/bench';
import type { HistoryStore } from './history';
import { RETENTION_DAYS } from './history';

const log = (...a: unknown[]) => console.error('[trainer]', ...a);

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const STALE_MS = 20 * HOUR;
export const STARTUP_DELAY_MS = 60_000;
const TIMEOUT_MS = 120_000;
const MAX_TIMER = 2 ** 31 - 1;

/** A snapshot read from disk is only trusted if it has the shape the UI relies on. */
export function validSnapshot(v: unknown): v is PredictionSnapshot {
  const s = v as PredictionSnapshot | null;
  return (
    !!s &&
    typeof s === 'object' &&
    s.version === 1 &&
    Number.isFinite(s.trainedAt) &&
    Array.isArray(s.sites) &&
    Array.isArray(s.sequences) &&
    !!s.aliases &&
    typeof s.aliases === 'object' &&
    !!s.hourly &&
    !!s.weekday
  );
}

/** Next 03:30 local time strictly after `from`. */
export function next0330(from: number): number {
  const d = new Date(from);
  d.setHours(3, 30, 0, 0);
  if (d.getTime() <= from) d.setDate(d.getDate() + 1);
  return d.getTime();
}

export class Trainer {
  snapshot: PredictionSnapshot | null = null;
  private running: Promise<PredictionSnapshot | null> | null = null;
  private timers: NodeJS.Timeout[] = [];
  readonly file: string;
  readonly evalFile: string;

  constructor(
    private dir: string,
    private history: HistoryStore,
    private onUpdate: (s: PredictionSnapshot | null) => void,
    /** Absolute path of the bundled worker entry. */
    private workerFile: string = path.join(__dirname, 'trainer-worker.js')
  ) {
    this.file = path.join(dir, 'predictions.json');
    this.evalFile = path.join(dir, 'predictions-eval.jsonl');
  }

  /** Read predictions.json (if any). Call once at startup. */
  load(): PredictionSnapshot | null {
    try {
      const v = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.snapshot = validSnapshot(v) ? v : null;
    } catch {
      this.snapshot = null;
    }
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

  /** Train now. Concurrent calls share one run. Resolves with the new snapshot, or null on failure. */
  train(forceTune = false): Promise<PredictionSnapshot | null> {
    if (this.running) return this.running;
    this.running = this.run(forceTune).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async run(forceTune: boolean): Promise<PredictionSnapshot | null> {
    const now = Date.now();
    const { visits, typed } = this.history.trainingData(now - RETENTION_DAYS * DAY);
    const t0 = performance.now();
    try {
      // self-tune about once a night (or when asked, e.g. after an import)
      const tune = forceTune || !this.snapshot?.eval || now - this.snapshot.eval.t > STALE_MS;
      const res = await this.inWorker({ kind: 'train', visits, typed, now, prev: this.snapshot, tune });
      const snap = res.snapshot;
      if (!validSnapshot(snap)) throw new Error('bad worker result');
      if (res.line && snap.eval) {
        const lines = appendLog(this.readLog(), res.line as EvalLine);
        this.writeLog(lines);
        snap.eval.trend = trend(lines, now);
        const r = regression(lines);
        if (r.alert) {
          snap.eval.alert = true;
          snap.eval.message = r.message;
        }
      }
      this.write(snap);
      this.snapshot = snap;
      log(`trained on ${visits.length} visits, ${typed.length} typed: ${snap.sites.length} sites, ${Object.keys(snap.aliases).length} shortcuts (${Math.round(performance.now() - t0)} ms${snap.eval && tune ? `, tuning ${snap.eval.status} in ${snap.eval.tuneMs} ms` : ''})`);
      this.onUpdate(snap);
      return snap;
    } catch (e) {
      log('training failed:', String(e instanceof Error ? e.message : e).slice(0, 200));
      return null;
    }
  }

  /** Run the search benchmark on the live history (worker thread). Null on failure. */
  async bench(): Promise<BenchResult | null> {
    const now = Date.now();
    const { visits, typed } = this.history.trainingData(now - RETENTION_DAYS * DAY);
    try {
      const res = await this.inWorker({ kind: 'bench', visits, typed, now, prev: this.snapshot });
      return (res.bench as BenchResult) ?? null;
    } catch (e) {
      log('benchmark failed:', String(e instanceof Error ? e.message : e).slice(0, 200));
      return null;
    }
  }

  /** Lines of predictions-eval.jsonl (the Settings sparkline reads this through the snapshot's neighbours). */
  readLog(): EvalLine[] {
    try {
      return parseLog(fs.readFileSync(this.evalFile, 'utf8'));
    } catch {
      return [];
    }
  }

  private writeLog(lines: EvalLine[]) {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.evalFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.evalFile);
  }

  private inWorker(job: unknown): Promise<{ snapshot?: PredictionSnapshot; line?: unknown; bench?: unknown }> {
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
      w.once('message', (m: { ok: boolean; snapshot?: PredictionSnapshot; line?: unknown; bench?: unknown; error?: string }) =>
        done(() => (m.ok ? resolve(m) : reject(new Error(m.error || 'bad worker result'))))
      );
      w.once('error', (e) => done(() => reject(e)));
      w.once('exit', (code) => done(() => reject(new Error(`worker exited (${code})`))));
    });
  }

  /** temp file (0600) + fsync + rename, so a crash never leaves a half-written snapshot. */
  private write(snap: PredictionSnapshot) {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(snap));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.file);
  }
}
