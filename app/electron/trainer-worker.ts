// Runs train() (and the nightly self-tune / benchmark) off the main thread (see trainer.ts).
// The worker reads visits/typed straight from history.sqlite (its own read-only connection), the
// previous snapshot from predictions.json, writes the new predictions.json + eval log itself, and
// sends main only a compact UI snapshot and a small summary. One job per worker.
import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { train, tune, runBench } from '../shared/lifeboard';
import { appendLog, parseLog, regression, trend } from '../shared/lifeboard/evallog';
import type { EvalLine } from '../shared/lifeboard/evallog';
import fs from 'node:fs';
import { readTrainingData } from './history';
import { compactSnapshot, readSnapshotFile, writeFileAtomic } from './snapshot';

interface Job {
  kind?: 'train' | 'bench';
  dbFile: string;
  predFile: string;
  evalFile: string;
  /** Visits/typed inputs since this epoch ms. */
  since: number;
  now: number;
  /** Run the self-tune before the final training. */
  tune?: boolean;
}

function openReadOnly(file: string): DatabaseSync {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 5000');
    db.prepare('SELECT 1 FROM visits LIMIT 1').get();
  } catch {
    db = new DatabaseSync(file);
    db.exec('PRAGMA busy_timeout = 5000');
  }
  return db;
}

try {
  const j = workerData as Job;
  const db = openReadOnly(j.dbFile);
  const { visits, typed } = (() => {
    try {
      return readTrainingData(db, j.since);
    } finally {
      db.close();
    }
  })();
  const prev = readSnapshotFile(j.predFile);
  if (j.kind === 'bench') {
    parentPort!.postMessage({ ok: true, bench: runBench(visits, typed, j.now, prev?.params) });
  } else {
    const t0 = performance.now();
    let params = prev?.params;
    let evalPart = prev?.eval;
    let line: EvalLine | null = null;
    if (j.tune) {
      const r = tune(visits, typed, j.now, params);
      params = r.params;
      evalPart = { ...r.eval, trend: null };
      line = {
        t: j.now, mode: r.eval.mode, n: r.eval.n, status: r.eval.status,
        metrics: { current: r.eval.previous ?? r.eval.metrics, chosen: r.eval.metrics },
        promoted: r.eval.status === 'promoted', params: r.params,
      } as EvalLine;
    }
    // the FINAL snapshot always trains on all visits with the chosen params
    const snapshot = train(visits, typed, j.now, prev, { params });
    if (evalPart) snapshot.eval = evalPart;
    if (line && snapshot.eval) {
      let old: EvalLine[] = [];
      try {
        old = parseLog(fs.readFileSync(j.evalFile, 'utf8'));
      } catch {
        /* no log yet */
      }
      const lines = appendLog(old, line);
      writeFileAtomic(j.evalFile, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
      snapshot.eval.trend = trend(lines, j.now);
      const r = regression(lines);
      if (r.alert) {
        snapshot.eval.alert = true;
        snapshot.eval.message = r.message;
      }
    }
    writeFileAtomic(j.predFile, JSON.stringify(snapshot));
    parentPort!.postMessage({
      ok: true,
      ui: compactSnapshot(snapshot),
      summary: { visits: visits.length, typed: typed.length, sites: snapshot.sites.length, aliases: Object.keys(snapshot.aliases).length, ms: Math.round(performance.now() - t0) },
    });
  }
} catch (e) {
  parentPort!.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) });
}
