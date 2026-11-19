// Local browsing-history store (main process only). Everything stays in <userData>/history.sqlite
// (node:sqlite, WAL, mode 0600). Recording is driven by hooks in tabs.ts; the UI reads it through
// validated IPC (see main.ts). Nothing here ever touches the network.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Transition, TypedInput, Visit } from '../shared/history-types';
import type { HistoryHit, ImportStatus } from '../shared/ipc';

const log = (...a: unknown[]) => console.error('[history]', ...a);

const DAY = 86_400_000;
export const RETENTION_DAYS = 180;
const DEDUPE_MS = 2000;
const TYPED_WINDOW_MS = 20_000;
const MAX_DWELL_MS = 2 * 3_600_000;
const MAX_URL = 2048;

export type ClearRange = 'hour' | 'day' | 'all';

interface Parsed {
  url: string;
  host: string;
  path: string;
  key: string; // url without the #fragment
  query?: string;
  engine?: Visit['engine'];
}

/** Lowercase host without a leading "www.". */
export function normHost(h: string): string {
  return h.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
}

const SEARCH_ENGINES: Array<{ re: RegExp; engine: NonNullable<Visit['engine']>; pathRe: RegExp }> = [
  { re: /^google\.[a-z.]+$/, engine: 'google', pathRe: /^\/search\/?$/ },
  { re: /^duckduckgo\.com$/, engine: 'duckduckgo', pathRe: /^\/$/ },
  { re: /^bing\.com$/, engine: 'bing', pathRe: /^\/search\/?$/ },
];

/** Parse a visit URL. Null for non-http(s) URLs and anything carrying credentials. */
export function parseVisitUrl(raw: string): Parsed | null {
  if (typeof raw !== 'string' || raw.length > MAX_URL) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  const host = normHost(u.hostname);
  if (!host) return null;
  const out: Parsed = { url: u.href, host, path: u.pathname, key: u.href.replace(/#.*$/, '') };
  for (const e of SEARCH_ENGINES) {
    if (!e.re.test(host) || !e.pathRe.test(u.pathname)) continue;
    const q = u.searchParams.get('q');
    if (q && q.trim()) {
      out.query = q.trim().slice(0, 300);
      out.engine = e.engine;
    }
    break;
  }
  return out;
}

/** Escape a string for use inside LIKE ... ESCAPE '\'. */
export function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Smallest string greater than every string starting with `p` (for index range scans). */
const prefixEnd = (p: string) => p + '￿';

interface TabState {
  id: number | null;
  key: string;
  host: string;
  t: number;
  since: number | null;
}

interface PendingTyped {
  host: string;
  t: number;
}

export class HistoryStore {
  private db: DatabaseSync | null = null;
  private tabs = new Map<string, TabState>();
  private typedMarks: PendingTyped[] = [];
  private skip = new Set<string>();
  private importing = false;
  private status: ImportStatus = { state: 'idle', imported: 0, skipped: 0 };

  /** `enabled` is read on every write, so toggling the setting takes effect immediately. */
  constructor(private dir: string, private enabled: () => boolean) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'history.sqlite');
      // Create with 0600 first; SQLite gives the -wal/-shm files the same permissions.
      fs.closeSync(fs.openSync(file, 'a', 0o600));
      fs.chmodSync(file, 0o600);
      this.db = new DatabaseSync(file);
      this.db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        CREATE TABLE IF NOT EXISTS visits (
          id INTEGER PRIMARY KEY,
          url TEXT NOT NULL,
          host TEXT NOT NULL,
          path TEXT NOT NULL DEFAULT '',
          title TEXT NOT NULL DEFAULT '',
          t INTEGER NOT NULL,
          transition TEXT NOT NULL DEFAULT 'link',
          query TEXT,
          engine TEXT,
          dwell_ms INTEGER
        );
        CREATE INDEX IF NOT EXISTS visits_t ON visits(t);
        CREATE INDEX IF NOT EXISTS visits_host ON visits(host);
        CREATE INDEX IF NOT EXISTS visits_url ON visits(url);
        CREATE UNIQUE INDEX IF NOT EXISTS visits_url_t ON visits(url, t);
        -- One row per distinct URL (visit count, last visit, latest title), kept in step by
        -- triggers so search never has to GROUP BY the whole visits table.
        CREATE TABLE IF NOT EXISTS pages (
          url TEXT PRIMARY KEY,
          host TEXT NOT NULL,
          title TEXT NOT NULL DEFAULT '',
          visits INTEGER NOT NULL,
          last_t INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS pages_host ON pages(host);
        CREATE INDEX IF NOT EXISTS pages_last ON pages(last_t);
        CREATE TRIGGER IF NOT EXISTS visits_ai AFTER INSERT ON visits BEGIN
          INSERT INTO pages (url, host, title, visits, last_t) VALUES (new.url, new.host, new.title, 1, new.t)
          ON CONFLICT(url) DO UPDATE SET visits = visits + 1, last_t = MAX(last_t, new.t),
            title = CASE WHEN new.title != '' THEN new.title ELSE title END;
        END;
        CREATE TRIGGER IF NOT EXISTS visits_title AFTER UPDATE OF title ON visits WHEN new.title != '' BEGIN
          UPDATE pages SET title = new.title WHERE url = new.url;
        END;
        CREATE TABLE IF NOT EXISTS typed_inputs (
          id INTEGER PRIMARY KEY,
          text TEXT NOT NULL,
          url TEXT NOT NULL DEFAULT '',
          shown_url TEXT,
          accepted INTEGER NOT NULL DEFAULT 0,
          t INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS typed_t ON typed_inputs(t);
      `);
      for (const ext of ['-wal', '-shm']) {
        try {
          fs.chmodSync(file + ext, 0o600);
        } catch {
          /* not created yet */
        }
      }
      const cutoff = Date.now() - RETENTION_DAYS * DAY;
      const gone = Number(this.db.prepare('DELETE FROM visits WHERE t < ?').run(cutoff).changes);
      this.db.prepare('DELETE FROM typed_inputs WHERE t < ?').run(cutoff);
      const np = Number((this.db.prepare('SELECT COUNT(*) AS n FROM pages').get() as { n: number }).n);
      if (gone || np === 0) this.rebuildPages(this.db);
    } catch (e) {
      log('history store unavailable:', String(e).slice(0, 200));
      this.db = null;
    }
  }

  private rebuildPages(db: DatabaseSync) {
    db.exec(`DELETE FROM pages;
      INSERT INTO pages (url, host, title, visits, last_t)
        SELECT url, MIN(host), COALESCE((SELECT v2.title FROM visits v2 WHERE v2.url = v.url AND v2.title != '' ORDER BY v2.t DESC LIMIT 1), ''), COUNT(*), MAX(t)
        FROM visits v GROUP BY url;`);
  }

  get ready() {
    return !!this.db;
  }

  private on() {
    return !!this.db && this.enabled();
  }

  private guard<T>(what: string, fn: (db: DatabaseSync) => T, fallback: T): T {
    if (!this.db) return fallback;
    try {
      return fn(this.db);
    } catch (e) {
      log(what, 'failed:', String(e).slice(0, 200));
      return fallback;
    }
  }

  // ---- recording (called from tabs.ts) ---------------------------------------------------------

  /** A tab restored after a memory discard reloads its page: don't count that as a new visit. */
  skipNext(tabId: string) {
    this.skip.add(tabId);
  }

  /** A main-frame navigation committed in `tabId`. `attached` = the tab is in front right now. */
  visit(tabId: string, url: string, title: string, attached: boolean, inPage = false, now = Date.now()) {
    if (this.skip.delete(tabId) && !inPage) return;
    if (!this.on()) {
      this.tabs.delete(tabId);
      return;
    }
    const p = parseVisitUrl(url);
    const prev = this.tabs.get(tabId);
    if (!p) {
      if (prev) this.finishDwell(prev, now);
      this.tabs.delete(tabId);
      return;
    }
    // Reload duplicates within 2 s, and hash-only in-page changes, are not new visits.
    if (prev && prev.key === p.key && (inPage || now - prev.t < DEDUPE_MS)) return;
    if (prev) this.finishDwell(prev, now);
    let transition: Transition = p.engine ? 'search' : 'link';
    if (!p.engine && this.consumeTyped(p.host, now)) transition = 'typed';
    else if (!p.engine && prev && prev.key === p.key) transition = 'reload';
    const id = this.guard(
      'insert visit',
      (db) => {
        const r = db
          .prepare('INSERT OR IGNORE INTO visits (url, host, path, title, t, transition, query, engine) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(p.url, p.host, p.path, (title || '').slice(0, 300), now, transition, p.query ?? null, p.engine ?? null);
        return r.changes ? Number(r.lastInsertRowid) : null;
      },
      null
    );
    this.tabs.set(tabId, { id, key: p.key, host: p.host, t: now, since: attached ? now : null });
  }

  /** The page title arrived or changed. */
  title(tabId: string, url: string, title: string) {
    const s = this.tabs.get(tabId);
    const p = parseVisitUrl(url);
    if (!s || s.id === null || !p || p.key !== s.key || !title || !this.on()) return;
    this.guard('update title', (db) => db.prepare('UPDATE visits SET title = ? WHERE id = ?').run(title.slice(0, 300), s.id), undefined);
  }

  /** Tab went to the background (or window hidden): stop its dwell clock. */
  background(tabId: string, now = Date.now()) {
    const s = this.tabs.get(tabId);
    if (s) this.finishDwell(s, now);
  }

  /** Tab came to the front: restart its dwell clock. */
  foreground(tabId: string, now = Date.now()) {
    const s = this.tabs.get(tabId);
    if (s && s.id !== null && s.since === null) s.since = now;
  }

  tabClosed(tabId: string) {
    this.background(tabId);
    this.tabs.delete(tabId);
    this.skip.delete(tabId);
  }

  /** Flush dwell for everything still open (app quit) and close the database. */
  close() {
    for (const s of this.tabs.values()) this.finishDwell(s);
    this.tabs.clear();
    try {
      this.db?.close();
    } catch {
      /* already closed */
    }
    this.db = null;
  }

  private finishDwell(s: TabState, now = Date.now()) {
    if (s.since === null) return;
    const ms = Math.min(Math.max(0, now - s.since), MAX_DWELL_MS);
    s.since = null;
    if (s.id === null || !this.db || ms < 1) return;
    this.guard('update dwell', (db) => db.prepare('UPDATE visits SET dwell_ms = COALESCE(dwell_ms, 0) + ? WHERE id = ?').run(ms, s.id), undefined);
  }

  private consumeTyped(host: string, now: number): boolean {
    this.typedMarks = this.typedMarks.filter((m) => now - m.t < TYPED_WINDOW_MS);
    const i = this.typedMarks.findIndex((m) => m.host === host);
    if (i < 0) return false;
    this.typedMarks.splice(i, 1);
    return true;
  }

  // ---- typed inputs ----------------------------------------------------------------------------

  /** The UI reports what was typed in the address bar / omnibox and where it led. */
  typed(i: { text: string; url: string; shownUrl?: string; accepted: boolean }, now = Date.now()) {
    if (!this.on()) return;
    const dest = i.url ? parseVisitUrl(i.url) : null;
    const shown = i.shownUrl ? parseVisitUrl(i.shownUrl) : null;
    this.guard(
      'insert typed',
      (db) => db.prepare('INSERT INTO typed_inputs (text, url, shown_url, accepted, t) VALUES (?, ?, ?, ?, ?)').run(i.text.slice(0, 500), dest?.url ?? '', shown?.url ?? null, i.accepted ? 1 : 0, now),
      undefined
    );
    if (!dest) return;
    // Mark the coming navigation as typed. If it already committed, upgrade that visit instead.
    for (const s of this.tabs.values()) {
      if (s.host === dest.host && s.id !== null && now - s.t < 5000) {
        this.guard('mark typed', (db) => db.prepare("UPDATE visits SET transition = 'typed' WHERE id = ? AND transition = 'link'").run(s.id), undefined);
        return;
      }
    }
    this.typedMarks.push({ host: dest.host, t: now });
    if (this.typedMarks.length > 20) this.typedMarks.shift();
  }

  // ---- queries for the UI ----------------------------------------------------------------------

  /** Sites matching `text`: host prefix first, then URL prefix, then title words. */
  search(text: string, limit = 8): HistoryHit[] {
    const q = text.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '');
    if (!q) return [];
    const lim = Math.max(1, Math.min(20, Math.floor(limit) || 8));
    return this.guard(
      'search',
      (db) => {
        const hits: HistoryHit[] = [];
        const seen = new Set<string>();
        const add = (rows: unknown[]) => {
          for (const r of rows as Array<{ url: string; host: string; title: string; visits: number; lastT: number }>) {
            if (hits.length >= lim || seen.has(r.url)) continue;
            seen.add(r.url);
            hits.push({ url: r.url, host: r.host, title: r.title, visits: Number(r.visits), lastT: Number(r.lastT) });
          }
        };
        const cols = 'url, host, title, visits, last_t AS lastT';
        const order = 'ORDER BY visits DESC, last_t DESC LIMIT ?';
        // 1. host prefix (index range scan)
        // Very short prefixes match huge swathes of history: look at recent pages only.
        if (q.length < 3) add(db.prepare(`SELECT ${cols} FROM (SELECT * FROM pages ORDER BY last_t DESC LIMIT 4000) WHERE host >= ? AND host < ? ${order}`).all(q, prefixEnd(q), lim * 3));
        else add(db.prepare(`SELECT ${cols} FROM pages WHERE host >= ? AND host < ? ${order}`).all(q, prefixEnd(q), lim * 3));
        // 2. URL prefix with or without scheme / www (primary-key range scans)
        if (hits.length < lim) {
          for (const pre of [`https://${q}`, `https://www.${q}`, `http://${q}`, `http://www.${q}`]) {
            if (hits.length >= lim) break;
            add(db.prepare(`SELECT ${cols} FROM pages WHERE url >= ? AND url < ? ${order}`).all(pre, prefixEnd(pre), lim));
          }
        }
        // 3. title starts with / has a word starting with the text (LIKE, escaped). Bounded to the
        //    5000 most recently visited pages so it stays fast on very large histories.
        if (hits.length < lim) {
          const e = likeEscape(q);
          add(
            db
              .prepare(`SELECT ${cols} FROM (SELECT * FROM pages ORDER BY last_t DESC LIMIT 5000) WHERE title LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' ${order}`)
              .all(`${e}%`, `% ${e}%`, lim)
          );
        }
        return hits;
      },
      []
    );
  }

  recent(limit = 20): Visit[] {
    const lim = Math.max(1, Math.min(200, Math.floor(limit) || 20));
    return this.guard(
      'recent',
      (db) =>
        (db.prepare('SELECT url, host, path, title, t, transition, query, engine, dwell_ms FROM visits ORDER BY t DESC LIMIT ?').all(lim) as Array<Record<string, unknown>>).map(
          rowToVisit
        ),
      []
    );
  }

  /** Delete visits (and typed inputs) from the last hour / day, or everything. Returns visits deleted. */
  clear(range: ClearRange): number {
    const since = range === 'all' ? 0 : Date.now() - (range === 'hour' ? 3_600_000 : DAY);
    return this.guard(
      'clear',
      (db) => {
        const n = Number(db.prepare('DELETE FROM visits WHERE t >= ?').run(since).changes);
        db.prepare('DELETE FROM typed_inputs WHERE t >= ?').run(since);
        if (range === 'all') db.exec('DELETE FROM pages');
        else this.rebuildPages(db);
        if (range === 'all') db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        return n;
      },
      0
    );
  }

  /** Everything the nightly trainer needs: visits and typed inputs since `sinceT` (epoch ms), oldest first. */
  trainingData(sinceT: number): { visits: Visit[]; typed: TypedInput[] } {
    return this.guard(
      'training data',
      (db) => ({
        visits: (db.prepare('SELECT url, host, path, title, t, transition, query, engine, dwell_ms FROM visits WHERE t >= ? ORDER BY t').all(sinceT) as Array<Record<string, unknown>>).map(rowToVisit),
        typed: (db.prepare('SELECT text, url, shown_url, accepted, t FROM typed_inputs WHERE t >= ? ORDER BY t').all(sinceT) as Array<Record<string, unknown>>).map((r) => {
          const ti: TypedInput = { text: String(r.text), url: String(r.url ?? ''), accepted: Number(r.accepted) === 1, t: Number(r.t) };
          if (r.shown_url) ti.shownUrl = String(r.shown_url);
          return ti;
        }),
      }),
      { visits: [], typed: [] }
    );
  }

  /** Row counts, for tests and diagnostics. */
  counts() {
    return this.guard(
      'counts',
      (db) => ({
        visits: Number((db.prepare('SELECT COUNT(*) AS n FROM visits').get() as { n: number }).n),
        typed: Number((db.prepare('SELECT COUNT(*) AS n FROM typed_inputs').get() as { n: number }).n),
      }),
      { visits: 0, typed: 0 }
    );
  }

  /** Raw access for tests only. */
  raw(): DatabaseSync | null {
    return this.db;
  }

  // ---- Firefox import (opt-in, one shot per click) ---------------------------------------------

  importStatus(): ImportStatus {
    return { ...this.status };
  }

  /** Where Firefox might keep its profiles on Linux (regular and snap installs). */
  static defaultFirefoxRoots(): string[] {
    const home = os.homedir();
    return [path.join(home, '.mozilla', 'firefox'), path.join(home, 'snap', 'firefox', 'common', '.mozilla', 'firefox')];
  }

  /**
   * Import the last 180 days from Firefox's places.sqlite. Works on a COPY in a private temp dir;
   * the live profile is never opened. `roots` is for tests only (never reachable from IPC).
   */
  async importFirefox(roots: string[] = HistoryStore.defaultFirefoxRoots()): Promise<ImportStatus> {
    if (this.importing) return this.importStatus();
    if (!this.db) {
      this.status = { state: 'error', imported: 0, skipped: 0, error: 'History store is unavailable' };
      return this.importStatus();
    }
    this.importing = true;
    this.status = { state: 'running', imported: 0, skipped: 0 };
    let tmp = '';
    try {
      const profile = findFirefoxProfile(roots);
      if (!profile) throw new Error('No Firefox profile with history found');
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jivvy-ffimport-'));
      const copy = path.join(tmp, 'places.sqlite');
      fs.copyFileSync(path.join(profile, 'places.sqlite'), copy);
      const wal = path.join(profile, 'places.sqlite-wal');
      if (fs.existsSync(wal)) fs.copyFileSync(wal, copy + '-wal');
      let src: DatabaseSync;
      try {
        src = new DatabaseSync(copy, { readOnly: true });
        src.prepare('SELECT 1 FROM moz_places LIMIT 1').get();
      } catch {
        // A read-only handle can't replay a WAL; our copy is disposable, so open it normally.
        src = new DatabaseSync(copy);
      }
      try {
        const cutoffUs = (Date.now() - RETENTION_DAYS * DAY) * 1000;
        const rows = src
          .prepare(
            `SELECT p.url AS url, p.title AS title, v.visit_date AS d, v.visit_type AS vt
             FROM moz_historyvisits v JOIN moz_places p ON p.id = v.place_id
             WHERE v.visit_date >= ? AND v.visit_type != 9 AND (p.url LIKE 'http://%' OR p.url LIKE 'https://%')
             ORDER BY v.visit_date`
          )
          .all(cutoffUs) as Array<{ url: string; title: string | null; d: number; vt: number }>;
        const ins = this.db.prepare('INSERT OR IGNORE INTO visits (url, host, path, title, t, transition, query, engine) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
        let imported = 0;
        let skipped = 0;
        const BATCH = 2000;
        for (let i = 0; i < rows.length; i += BATCH) {
          this.db.exec('BEGIN');
          try {
            for (const r of rows.slice(i, i + BATCH)) {
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
            this.db.exec('COMMIT');
          } catch (e) {
            this.db.exec('ROLLBACK');
            throw e;
          }
          this.status = { state: 'running', imported, skipped };
          await new Promise((r) => setImmediate(r)); // let the app breathe between batches
        }
        this.status = { state: 'done', imported, skipped, at: Date.now() };
      } finally {
        try {
          src.close();
        } catch {
          /* ignore */
        }
      }
    } catch (e) {
      this.status = { state: 'error', imported: this.status.imported, skipped: this.status.skipped, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
    } finally {
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
      this.importing = false;
    }
    return this.importStatus();
  }
}

function rowToVisit(r: Record<string, unknown>): Visit {
  const v: Visit = {
    url: String(r.url),
    host: String(r.host),
    path: String(r.path ?? ''),
    title: String(r.title ?? ''),
    t: Number(r.t),
    transition: String(r.transition) as Transition,
  };
  if (r.query) v.query = String(r.query);
  if (r.engine) v.engine = String(r.engine) as Visit['engine'];
  if (r.dwell_ms !== null && r.dwell_ms !== undefined) v.dwellMs = Number(r.dwell_ms);
  return v;
}

/** Minimal INI reader: [section] -> key -> value. */
function parseIni(text: string): Array<{ name: string; kv: Record<string, string> }> {
  const out: Array<{ name: string; kv: Record<string, string> }> = [];
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    const m = /^\[(.+)\]$/.exec(s);
    if (m) out.push({ name: m[1], kv: {} });
    else if (out.length && s && !s.startsWith(';') && !s.startsWith('#')) {
      const i = s.indexOf('=');
      if (i > 0) out[out.length - 1].kv[s.slice(0, i).trim()] = s.slice(i + 1).trim();
    }
  }
  return out;
}

/** The default Firefox profile dir (one that has places.sqlite) from the first root that has one. */
export function findFirefoxProfile(roots: string[]): string | null {
  for (const root of roots) {
    const resolve = (p: string, rel: boolean) => path.resolve(rel ? path.join(root, p) : p);
    const ok = (d: string) => fs.existsSync(path.join(d, 'places.sqlite'));
    let ini: ReturnType<typeof parseIni> = [];
    try {
      ini = parseIni(fs.readFileSync(path.join(root, 'profiles.ini'), 'utf8'));
    } catch {
      /* no profiles.ini in this root */
    }
    const cands: string[] = [];
    // The profile the installed Firefox actually uses, then the one flagged Default=1.
    for (const s of ini.filter((x) => x.name.startsWith('Install'))) if (s.kv.Default) cands.push(resolve(s.kv.Default, !path.isAbsolute(s.kv.Default)));
    for (const s of ini.filter((x) => x.name.startsWith('Profile') && x.kv.Default === '1' && x.kv.Path)) cands.push(resolve(s.kv.Path, s.kv.IsRelative !== '0'));
    for (const s of ini.filter((x) => x.name.startsWith('Profile') && x.kv.Path)) cands.push(resolve(s.kv.Path, s.kv.IsRelative !== '0'));
    for (const c of cands) if (ok(c)) return c;
  }
  return null;
}
