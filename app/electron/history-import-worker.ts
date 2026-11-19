// Firefox history import, off the main thread (see HistoryStore.importFirefox). Copies places.sqlite
// (+ WAL) to a private temp dir, reads the copy, and inserts into history.sqlite over this worker's
// own connection (WAL lets main keep reading/writing meanwhile). Batched transactions, progress posts.
import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Transition } from '../shared/history-types';
import { findFirefoxProfile, parseVisitUrl } from './history';

const BATCH = 2000;

interface Job {
  dbFile: string;
  roots: string[];
  cutoffMs: number;
}

const post = (m: unknown) => parentPort!.postMessage(m);

function run(j: Job): unknown {
  let tmp = '';
  let dst: DatabaseSync | null = null;
  let src: DatabaseSync | null = null;
  let imported = 0;
  let skipped = 0;
  try {
    const profile = findFirefoxProfile(j.roots);
    if (!profile) throw new Error('No Firefox profile with history found');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jivvy-ffimport-'));
    const copy = path.join(tmp, 'places.sqlite');
    fs.copyFileSync(path.join(profile, 'places.sqlite'), copy);
    const wal = path.join(profile, 'places.sqlite-wal');
    if (fs.existsSync(wal)) fs.copyFileSync(wal, copy + '-wal');
    try {
      src = new DatabaseSync(copy, { readOnly: true });
      src.prepare('SELECT 1 FROM moz_places LIMIT 1').get();
    } catch {
      // A read-only handle can't replay a WAL; our copy is disposable, so open it normally.
      src = new DatabaseSync(copy);
    }
    const rows = src
      .prepare(
        `SELECT p.url AS url, p.title AS title, v.visit_date AS d, v.visit_type AS vt
         FROM moz_historyvisits v JOIN moz_places p ON p.id = v.place_id
         WHERE v.visit_date >= ? AND v.visit_type != 9 AND (p.url LIKE 'http://%' OR p.url LIKE 'https://%')
         ORDER BY v.visit_date`
      )
      .all(j.cutoffMs * 1000) as Array<{ url: string; title: string | null; d: number; vt: number }>;
    dst = new DatabaseSync(j.dbFile);
    dst.exec('PRAGMA busy_timeout = 10000; PRAGMA synchronous = NORMAL;');
    const ins = dst.prepare('INSERT OR IGNORE INTO visits (url, host, path, title, t, transition, query, engine) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (let i = 0; i < rows.length; i += BATCH) {
      dst.exec('BEGIN');
      try {
        const end = Math.min(rows.length, i + BATCH);
        for (let k = i; k < end; k++) {
          const r = rows[k];
          const p = parseVisitUrl(r.url);
          if (!p || !Number.isFinite(Number(r.d))) {
            skipped++;
            continue;
          }
          const transition: Transition = p.engine ? 'search' : r.vt === 2 ? 'typed' : 'link';
          const res = ins.run(p.url, p.host, p.path, (r.title || '').slice(0, 300), Math.floor(Number(r.d) / 1000), transition, p.query ?? null, p.engine ?? null);
          if (res.changes) imported++;
          else skipped++;
        }
        dst.exec('COMMIT');
      } catch (e) {
        dst.exec('ROLLBACK');
        throw e;
      }
      post({ type: 'progress', imported, skipped });
    }
    return { type: 'done', imported, skipped };
  } catch (e) {
    return { type: 'error', error: e instanceof Error ? e.message : String(e), imported, skipped };
  } finally {
    for (const d of [src, dst]) {
      try {
        d?.close();
      } catch {
        /* ignore */
      }
    }
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Report only after the temp copy is gone and the connections are closed (main may terminate us on receipt).
post(run(workerData as Job));
