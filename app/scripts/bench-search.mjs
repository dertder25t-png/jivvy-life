// Search / prediction benchmark.
//   npm run bench:search                      synthetic, deterministic history
//   npm run bench:search -- --db <history.sqlite>   also the real history (opened read-only from a temp copy)
// Needs Node 22.18+ (runs the shared TypeScript directly).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { formatBench, runBench, synthHistory } from '../shared/lifeboard/index.ts';

const argv = process.argv.slice(2);
const i = argv.indexOf('--db');
const dbArg = i >= 0 ? argv[i + 1] : null;
if (i >= 0 && !dbArg) {
  console.error('--db needs a path');
  process.exit(2);
}

const show = (title, r) => {
  console.log(`\n${title}  (${r.visits} visits, ${r.typed} typed inputs)`);
  console.log(formatBench(r));
  console.log(`tuning: ${r.tuning.status}${r.tuning.changed.length ? ' ' + r.tuning.changed.join(', ') : ''} in ${r.tuning.tuneMs} ms`);
};

const syn = synthHistory();
show('synthetic', runBench(syn.visits, syn.typed, syn.now));

if (dbArg) {
  const src = path.resolve(dbArg.replace(/^~(?=$|\/)/, os.homedir()));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-search-'));
  try {
    const copy = path.join(tmp, 'history.sqlite');
    fs.copyFileSync(src, copy);
    for (const ext of ['-wal', '-shm']) if (fs.existsSync(src + ext)) fs.copyFileSync(src + ext, copy + ext);
    const db = new DatabaseSync(copy, { readOnly: true });
    const visits = db.prepare('SELECT url, host, path, title, t, transition, query, engine, dwell_ms FROM visits ORDER BY t').all().map((r) => {
      const v = { url: String(r.url), host: String(r.host), path: String(r.path ?? ''), title: String(r.title ?? ''), t: Number(r.t), transition: String(r.transition) };
      if (r.query) v.query = String(r.query);
      if (r.engine) v.engine = String(r.engine);
      return v;
    });
    const typed = db.prepare('SELECT text, url, shown_url, accepted, t FROM typed_inputs ORDER BY t').all().map((r) => {
      const x = { text: String(r.text), url: String(r.url ?? ''), accepted: Number(r.accepted) === 1, t: Number(r.t) };
      if (r.shown_url) x.shownUrl = String(r.shown_url);
      return x;
    });
    db.close();
    show('real history', runBench(visits, typed, Date.now()));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
