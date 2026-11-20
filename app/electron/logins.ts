// Logins: Firefox cookie import into the pages' session, and saved passwords encrypted with
// Electron safeStorage (libsecret/KWallet). Passwords never leave main: the renderer only gets
// usernames, and fill_login injects straight into the tab. Nothing is stored in plaintext, and
// without a real OS keyring the password calls refuse. Cookie values and passwords are never logged.
import { safeStorage, type Session, type WebContents } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface LoginsOptions {
  userData: string;
  session: () => Session;
  webContentsOf: (tabId: string) => WebContents | null;
  /** Firefox profile roots. Defaults to the real ones; only the self-test overrides this. */
  firefoxRoots?: string[];
}

interface LoginRow {
  host: string;
  username: string;
  encryptedPasswordBase64: string;
}

export interface FirefoxCookieResult {
  imported: number;
  skipped: number;
  profile: string;
  /** Skip reasons with counts and a few cookie names (never values). */
  reasons: Array<{ reason: string; count: number; names: string[] }>;
}

const MAX_CSV = 20 * 1024 * 1024;

export function defaultFirefoxRoots(): string[] {
  const h = os.homedir();
  return [path.join(h, '.mozilla/firefox'), path.join(h, 'snap/firefox/common/.mozilla/firefox'), path.join(h, '.var/app/org.mozilla.firefox/.mozilla/firefox')];
}

/** Hostname (lowercase) of an http(s) URL, else null. */
function httpHost(url: string): { host: string; secure: boolean } | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return { host: u.hostname.toLowerCase(), secure: u.protocol === 'https:' };
  } catch {
    return null;
  }
}
const isLocal = (h: string) => h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
/** Passwords are only offered/filled on https pages (and localhost), never on plain http. */
const fillable = (u: { host: string; secure: boolean } | null): u is { host: string; secure: boolean } => !!u && (u.secure || isLocal(u.host));

/** Minimal RFC 4180 parser (quotes, doubled quotes, CRLF, embedded newlines). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let f = '';
  let q = false;
  let i = 0;
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  for (; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          f += '"';
          i++;
        } else q = false;
      } else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      row.push(f);
      f = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(f);
      f = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else f += c;
  }
  row.push(f);
  if (row.length > 1 || row[0] !== '') rows.push(row);
  return rows;
}

export class Logins {
  private indexFile: string;
  constructor(private o: LoginsOptions) {
    this.indexFile = path.join(o.userData, 'logins_index.json');
  }

  // ---------------- Firefox profile + cookies ----------------
  private findProfile(): string | null {
    for (const root of this.o.firefoxRoots ?? defaultFirefoxRoots()) {
      let ini: string;
      try {
        ini = fs.readFileSync(path.join(root, 'profiles.ini'), 'utf8');
      } catch {
        continue;
      }
      const sections: Array<[string, Record<string, string>]> = [];
      for (const raw of ini.split(/\r?\n/)) {
        const line = raw.trim();
        if (line.startsWith('[') && line.endsWith(']')) sections.push([line.slice(1, -1), {}]);
        else {
          const eq = line.indexOf('=');
          if (eq > 0 && sections.length) sections[sections.length - 1][1][line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
        }
      }
      const resolve = (p: string, rel: boolean) => (rel ? path.join(root, p) : p);
      const cands: string[] = [];
      for (const [n, kv] of sections) if (n.startsWith('Install') && kv.Default) cands.push(resolve(kv.Default, true));
      for (const [n, kv] of sections) if (n.startsWith('Profile') && kv.Default === '1' && kv.Path) cands.push(resolve(kv.Path, kv.IsRelative !== '0'));
      for (const [n, kv] of sections) if (n.startsWith('Profile') && kv.Path) cands.push(resolve(kv.Path, kv.IsRelative !== '0'));
      const hit = cands.find((p) => fs.existsSync(path.join(p, 'cookies.sqlite')));
      if (hit) return hit;
    }
    return null;
  }

  async importFirefoxCookies(): Promise<FirefoxCookieResult> {
    const profile = this.findProfile();
    if (!profile) throw new Error('No Firefox profile with cookies.sqlite found');
    type Raw = { name: string; value: string; host: string; path: string; expiry: number; secure: boolean; httpOnly: boolean; sameSite: number; plain: boolean };
    const raws: Raw[] = [];
    const skips = new Map<string, { count: number; names: string[] }>();
    const skip = (reason: string, name: string) => {
      const e = skips.get(reason) ?? { count: 0, names: [] };
      e.count++;
      if (e.names.length < 5 && !e.names.includes(name)) e.names.push(name);
      skips.set(reason, e);
    };
    const now = Math.floor(Date.now() / 1000);
    // Firefox keeps the live data in cookies.sqlite-wal while it runs. Copy db + wal (+shm) into a
    // private temp dir and open the copy, so SQLite replays the WAL there; the original is never
    // opened. The files are not copied atomically, so retry if Firefox checkpointed between the
    // copies and the snapshot came out inconsistent.
    let rows: Array<Record<string, unknown>> | null = null;
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 4 && !rows; attempt++) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jivvy-ffcookies-'));
      try {
        for (const f of ['cookies.sqlite', 'cookies.sqlite-wal', 'cookies.sqlite-shm']) {
          const src = path.join(profile, f);
          if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmp, f));
        }
        const db = new DatabaseSync(path.join(tmp, 'cookies.sqlite'));
        try {
          const cols = new Set((db.prepare('PRAGMA table_info(moz_cookies)').all() as Array<{ name: string }>).map((c) => c.name));
          const pick = (c: string, fallback: string) => (cols.has(c) ? c : `${fallback} AS ${c}`);
          rows = db
            .prepare(`SELECT name, value, host, path, expiry, ${pick('isSecure', '0')}, ${pick('isHttpOnly', '0')}, ${pick('sameSite', '0')}, ${pick('originAttributes', "''")} FROM moz_cookies`)
            .all() as Array<Record<string, unknown>>;
        } finally {
          db.close();
        }
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 150));
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }
    if (!rows) throw new Error(`Could not read Firefox cookies: ${(lastErr as Error)?.message ?? 'unknown error'}`);
    for (const r of rows) {
      let expiry = Number(r.expiry);
      if (expiry > 100_000_000_000) expiry = Math.floor(expiry / 1000); // newer Firefox: ms
      const name = String(r.name ?? '');
      const host = String(r.host ?? '');
      if (!name || !host) {
        skip('empty name or host', name);
        continue;
      }
      if (expiry > 0 && expiry <= now) {
        skip('expired', name);
        continue;
      }
      raws.push({
        name,
        value: String(r.value ?? ''),
        host,
        path: String(r.path || '/'),
        expiry: expiry > 0 ? Math.min(expiry, now + 400 * 86400) : now + 30 * 86400,
        secure: Number(r.isSecure) !== 0,
        httpOnly: Number(r.isHttpOnly) !== 0,
        sameSite: Number(r.sameSite ?? 0),
        plain: !String(r.originAttributes ?? ''),
      });
    }
    const cookies = this.o.session().cookies;
    let imported = 0;
    for (const c of raws) {
      // Container-tab and partitioned (third-party) cookies share name/host/path with the real ones;
      // setting them unpartitioned would overwrite the genuine sign-in cookies.
      if (!c.plain) {
        skip('container or partitioned cookie', c.name);
        continue;
      }
      const bare = c.host.replace(/^\./, '');
      if (!/^[a-z0-9.\-_:[\]]+$/i.test(bare)) {
        skip('invalid host', c.name);
        continue;
      }
      const prefixHost = c.name.startsWith('__Host-');
      const secure = c.secure || prefixHost || c.name.startsWith('__Secure-');
      const cpath = prefixHost ? '/' : c.path.startsWith('/') ? c.path : '/';
      try {
        await cookies.set({
          url: `${secure ? 'https' : 'http'}://${bare}${cpath}`,
          name: c.name,
          value: c.value,
          ...(c.host.startsWith('.') && !prefixHost ? { domain: c.host } : {}), // no domain => host-only (required for __Host-)
          path: cpath,
          secure,
          httpOnly: c.httpOnly,
          expirationDate: c.expiry,
          sameSite: c.sameSite === 1 ? 'lax' : c.sameSite === 2 ? 'strict' : secure ? 'no_restriction' : 'unspecified',
        });
        imported++;
      } catch (e) {
        let msg = String((e as Error)?.message ?? e).split('\n')[0].slice(0, 120);
        if (c.value.length > 3) msg = msg.split(c.value).join('…'); // never leak a value through an error
        skip(msg || 'set failed', c.name);
      }
    }
    // Chromium writes cookies to disk lazily; make the import durable now.
    await this.o.session().cookies.flushStore();
    const reasons = [...skips].map(([reason, v]) => ({ reason, count: v.count, names: v.names })).sort((a, b) => b.count - a.count);
    return { imported, skipped: reasons.reduce((n, r) => n + r.count, 0), profile: path.basename(profile), reasons };
  }

  // ---------------- passwords ----------------
  /** Throws unless the OS keyring is genuinely usable (never falls back to plaintext). */
  private requireKeyring() {
    let ok = false;
    let backend = '';
    try {
      ok = safeStorage.isEncryptionAvailable();
      if (process.platform === 'linux') backend = safeStorage.getSelectedStorageBackend();
    } catch {
      ok = false;
    }
    if (!ok || backend === 'basic_text' || backend === 'unknown')
      throw new Error('No secure keyring available (need KWallet or GNOME Keyring/libsecret, unlocked). Passwords were not stored.');
  }

  private readIndex(): LoginRow[] {
    try {
      const v = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
      return Array.isArray(v) ? v.filter((r) => r && typeof r.host === 'string' && typeof r.username === 'string' && typeof r.encryptedPasswordBase64 === 'string') : [];
    } catch {
      return [];
    }
  }

  private writeIndex(rows: LoginRow[]) {
    fs.mkdirSync(this.o.userData, { recursive: true });
    const tmp = `${this.indexFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rows), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.indexFile);
  }

  importPasswordsCsv(csv: string): { imported: number; skipped: number } {
    if (csv.length > MAX_CSV) throw new Error('CSV too large');
    this.requireKeyring();
    const rows = parseCsv(csv);
    if (!rows.length) throw new Error('CSV must have url, username, password columns');
    const head = rows[0].map((h) => h.trim().toLowerCase());
    const cu = head.indexOf('url');
    const cn = head.indexOf('username');
    const cp = head.indexOf('password');
    const cr = head.indexOf('httprealm');
    if (cu < 0 || cn < 0 || cp < 0) throw new Error('CSV must have url, username, password columns');
    const index = this.readIndex();
    let imported = 0;
    let skipped = 0;
    for (const rec of rows.slice(1)) {
      const u = httpHost(rec[cu] ?? '');
      const user = rec[cn] ?? '';
      const pass = rec[cp] ?? '';
      if (!u || !user || !pass || user.length > 512 || pass.length > 4096 || (cr >= 0 && (rec[cr] ?? '') !== '')) {
        skipped++;
        continue;
      }
      let enc: string;
      try {
        enc = safeStorage.encryptString(pass).toString('base64');
      } catch {
        skipped++;
        continue;
      }
      const row = { host: u.host, username: user, encryptedPasswordBase64: enc };
      const at = index.findIndex((r) => r.host === u.host && r.username === user);
      if (at >= 0) index[at] = row;
      else index.push(row);
      imported++;
    }
    if (imported === 0 && skipped > 0) throw new Error('No passwords could be imported (need url, username, password on https pages)');
    this.writeIndex(index);
    return { imported, skipped };
  }

  loginsFor(origin: string): string[] {
    const u = httpHost(origin);
    if (!fillable(u)) return [];
    return this.readIndex()
      .filter((r) => r.host === u.host)
      .map((r) => r.username);
  }

  async fillLogin(tabId: string, username: string): Promise<void> {
    this.requireKeyring();
    const wc = this.o.webContentsOf(tabId);
    if (!wc) throw new Error('pane not found');
    const u = httpHost(wc.getURL());
    if (!fillable(u)) throw new Error('page is not https');
    const row = this.readIndex().find((r) => r.host === u.host && r.username === username);
    if (!row) throw new Error('no saved login for this site');
    let pass: string;
    try {
      pass = safeStorage.decryptString(Buffer.from(row.encryptedPasswordBase64, 'base64'));
    } catch {
      throw new Error('could not decrypt saved password');
    }
    // The page may have navigated while the keyring was answering.
    const now = wc.isDestroyed() ? null : httpHost(wc.getURL());
    if (!now || now.host !== u.host || !fillable(now)) throw new Error('page changed before filling; try again');
    const js = `(function(u,p){const vis=e=>e.offsetParent!==null||e.getClientRects().length>0;
const set=(e,v)=>{const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;s.call(e,v);
e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));};
const all=[...document.querySelectorAll('input')].filter(vis);
const pw=all.find(e=>e.type==='password');
let un=null;
if(pw){const i=all.indexOf(pw);for(let k=i-1;k>=0;k--){if(['text','email','tel',''].includes(all[k].type)){un=all[k];break;}}}
else{un=all.find(e=>['email','text'].includes(e.type)&&/user|email|login|mail/i.test((e.name||'')+(e.id||'')+(e.autocomplete||'')))||null;}
if(un)set(un,u);if(pw)set(pw,p);return !!(un||pw);})(${JSON.stringify(username)},${JSON.stringify(pass)})`;
    try {
      await wc.executeJavaScript(js, false);
    } catch {
      throw new Error('could not fill this page'); // do not surface the error text: it may echo the script
    }
  }

  forgetAll(): number {
    const n = this.readIndex().length;
    try {
      fs.rmSync(this.indexFile, { force: true });
    } catch {
      /* ignore */
    }
    return n;
  }
}
