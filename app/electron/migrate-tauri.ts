// One-time migration from the old Tauri/WebKitGTK build (~/.local/share/com.jivvy.life) into this
// Electron build: workspaces/tabs/folders/notes/layout/prefs (WebKit localStorage), cookies
// (libsoup jar), saved logins (Secret Service) and the dashboard's localStorage keys.
//
// The old directory is only ever READ, and only from temp copies. Nothing here logs or returns a
// cookie value, a password or a login URL: counts only.
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Session } from 'electron';
import { DEFAULT_PREFS, cleanSites, hydrate, isValidId, validNote, validTab, withDashboard, type PersistedState } from '../shared/state';
import type { LayoutMode } from '../shared/layout';
import type { NoteDocument, TabFolder, WorkspaceManifest, WorkspaceTab } from '../shared/types';
import { classifyMozCookieRows, importMozCookieRows, readMozCookieRows, type Logins } from './logins';

export const MARKER = 'migrated-from-tauri.json';
export const DASH_PENDING = 'migrated-dash.json';
const STATE_FILE = 'jivvy-state.json';
const LOGINS_FILE = 'logins_index.json';
const log = (...a: unknown[]) => console.error('[migrate]', ...a);

export function defaultTauriDir(): string {
  const env = process.env.JIVVY_SELFTEST === '1' ? process.env.JIVVY_TAURI_DIR : undefined; // tests only
  if (env) return env;
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'com.jivvy.life');
}

// ---------------------------------------------------------------------------------------------
// Reading the old data

export interface PasswordRead {
  /** Entries in the Secret Service under our service name. */
  found: number;
  /** Of those, how many could be read without any prompt. */
  readable: number;
  /** Items in a locked collection (would need the user to unlock). */
  locked: number;
  /** `origin|username` -> password. Only present when asked for; never logged. */
  secrets?: Map<string, string>;
  error?: string;
}
export type PasswordReader = (wantSecrets: boolean) => Promise<PasswordRead>;

// The old build stored each password through the `keyring` crate (Secret Service: service
// "jivvy-life", account "<origin>|<username>"). On Linux that is KWallet or GNOME Keyring behind
// org.freedesktop.secrets. Read it over D-Bus with GLib (python3-gi), asking only for items that are
// already unlocked, so no prompt ever appears. The secrets go to our stdout pipe, never to a log.
const SS_PY = String.raw`
import sys, json, base64
try:
    import gi
    from gi.repository import Gio, GLib
except Exception:
    print(json.dumps({"error": "python3-gi not available"})); sys.exit(0)
want = sys.argv[1] == "secrets"
D = "org.freedesktop.secrets"
try:
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    def call(path, iface, m, args, sig):
        return bus.call_sync(D, path, iface, m, args, GLib.VariantType(sig), Gio.DBusCallFlags.NONE, 8000, None).unpack()
    S = "/org/freedesktop/secrets"; SI = "org.freedesktop.Secret.Service"; II = "org.freedesktop.Secret.Item"
    _, sess = call(S, SI, "OpenSession", GLib.Variant("(sv)", ("plain", GLib.Variant("s", ""))), "(vo)")
    unlocked, locked = call(S, SI, "SearchItems", GLib.Variant("(a{ss})", ({"service": "jivvy-life"},)), "(aoao)")
    items = []; readable = 0
    for it in unlocked:
        try:
            attrs = call(it, "org.freedesktop.DBus.Properties", "Get", GLib.Variant("(ss)", (II, "Attributes")), "(v)")[0]
            sec = call(it, II, "GetSecret", GLib.Variant("(o)", (sess,)), "((oayays))")[0]
            readable += 1
            if want:
                items.append({"u": attrs.get("username", ""), "p": base64.b64encode(bytes(sec[2])).decode()})
        except Exception:
            pass
    print(json.dumps({"found": len(unlocked) + len(locked), "readable": readable, "locked": len(locked), "items": items}))
except Exception as e:
    print(json.dumps({"error": "secret service unavailable"}))
`;

export const readSecretServicePasswords: PasswordReader = (wantSecrets) =>
  new Promise((resolve) => {
    execFile('python3', ['-I', '-c', SS_PY, wantSecrets ? 'secrets' : 'count'], { timeout: 30_000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env } }, (err, stdout) => {
      const none: PasswordRead = { found: 0, readable: 0, locked: 0 };
      if (err) return resolve({ ...none, error: 'could not run the keyring reader' });
      try {
        const j = JSON.parse(stdout) as { error?: string; found?: number; readable?: number; locked?: number; items?: Array<{ u: string; p: string }> };
        if (j.error) return resolve({ ...none, error: j.error });
        const secrets = wantSecrets ? new Map((j.items ?? []).map((i) => [i.u, Buffer.from(i.p, 'base64').toString('utf8')])) : undefined;
        resolve({ found: j.found ?? 0, readable: j.readable ?? 0, locked: j.locked ?? 0, secrets });
      } catch {
        resolve({ ...none, error: 'unreadable keyring reply' });
      }
    });
  });

function findLocalStorageFile(dir: string): string | null {
  const ls = path.join(dir, 'localstorage');
  const exact = path.join(ls, 'tauri_localhost_0.localstorage');
  if (fs.existsSync(exact)) return exact;
  try {
    const f = fs.readdirSync(ls).find((n) => /tauri/i.test(n) && n.endsWith('.localstorage'));
    return f ? path.join(ls, f) : null;
  } catch {
    return null;
  }
}

/** Copy db (+wal/shm) to a temp dir, read ItemTable, decode UTF-16LE. The original is never opened. */
export async function readOldLocalStorage(dir: string): Promise<Map<string, string>> {
  const file = findLocalStorageFile(dir);
  if (!file) throw new Error('old localStorage database not found');
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jivvy-migrate-'));
    try {
      for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(file + suffix)) fs.copyFileSync(file + suffix, path.join(tmp, `ls.sqlite${suffix}`));
      const db = new DatabaseSync(path.join(tmp, 'ls.sqlite'));
      try {
        const out = new Map<string, string>();
        for (const r of db.prepare('SELECT key, value FROM ItemTable').all() as Array<{ key: unknown; value: unknown }>) {
          const v = r.value;
          out.set(String(r.key), typeof v === 'string' ? v : Buffer.from(v as Uint8Array).toString('utf16le'));
        }
        return out;
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
  throw new Error(`could not read old localStorage: ${(lastErr as Error)?.message ?? 'unknown'}`);
}

const parseJson = (s: string | undefined): unknown => {
  if (s == null) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};
const MODES: LayoutMode[] = ['left-vertical', 'compact-rail', 'classic-top', 'zen'];

function cleanWorkspaces(raw: unknown): WorkspaceManifest[] {
  if (!Array.isArray(raw)) return [];
  const out: WorkspaceManifest[] = [];
  for (const w of raw) {
    if (!w || typeof w !== 'object' || !isValidId((w as WorkspaceManifest).id)) continue;
    const x = w as WorkspaceManifest;
    const tabs: WorkspaceTab[] = (Array.isArray(x.tabs) ? x.tabs : [])
      .filter((t) => validTab({ ...(t as object), lastActiveAt: undefined }))
      .map((t) => ({ ...t, lastActiveAt: typeof t.lastActiveAt === 'string' ? t.lastActiveAt : new Date().toISOString() }));
    const folders: TabFolder[] = (Array.isArray(x.folders) ? x.folders : []).filter((f) => f && isValidId(f.id) && typeof f.name === 'string');
    const has = (id: string | null) => !!id && tabs.some((t) => t.id === id);
    out.push({
      id: x.id,
      name: typeof x.name === 'string' && x.name ? x.name : 'Workspace',
      contextTag: x.contextTag ?? 'personal',
      layout: x.layout === 'split-vertical' && has(x.secondaryTabId) ? 'split-vertical' : 'single',
      primaryTabId: has(x.primaryTabId) ? x.primaryTabId : tabs[0]?.id ?? null,
      secondaryTabId: has(x.secondaryTabId) ? x.secondaryTabId : null,
      tabs,
      folders: folders.map((f) => ({ ...f, name: f.name.slice(0, 256) })),
      updatedAt: typeof x.updatedAt === 'string' ? x.updatedAt : new Date().toISOString(),
    });
  }
  return out;
}

export interface OldLogin {
  origin: string;
  host: string;
  username: string;
}
export interface OldData {
  workspaces: WorkspaceManifest[];
  notes: NoteDocument[];
  prefs: Partial<PersistedState>;
  layout: LayoutMode | null;
  dash: { links?: unknown; notes?: unknown; recent?: unknown };
  queues: { sync: number; telemetry: number };
  cookieRows: Array<Record<string, unknown>>;
  logins: OldLogin[];
}

function readLoginsIndex(dir: string): OldLogin[] {
  const out: OldLogin[] = [];
  try {
    const idx = JSON.parse(fs.readFileSync(path.join(dir, LOGINS_FILE), 'utf8')) as Record<string, unknown>;
    for (const [origin, users] of Object.entries(idx)) {
      let host: string;
      try {
        const u = new URL(origin);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
        host = u.hostname.toLowerCase();
      } catch {
        continue;
      }
      if (Array.isArray(users)) for (const name of users) if (typeof name === 'string' && name) out.push({ origin, host, username: name });
    }
  } catch {
    /* no index: no logins */
  }
  return out;
}

export async function readOldData(dir: string): Promise<OldData> {
  const ls = await readOldLocalStorage(dir);
  const ui = parseJson(ls.get('life_app_ui_prefs_v1'));
  const prefs: Partial<PersistedState> = {};
  if (ui && typeof ui === 'object') {
    const p = ui as Record<string, unknown>;
    for (const k of ['showTopBar', 'autoHideAddressBar', 'showFolders', 'blockingEnabled'] as const) if (typeof p[k] === 'boolean') prefs[k] = p[k] as boolean;
    if (p.zenBarPosition === 'top' || p.zenBarPosition === 'bottom' || p.zenBarPosition === 'left') prefs.zenBarPosition = p.zenBarPosition;
    if (Array.isArray(p.blockingDisabledSites)) prefs.blockingDisabledSites = p.blockingDisabledSites.filter((x): x is string => typeof x === 'string');
    // clearTabsOnStart is deliberately not carried over: hydrating with it on would wipe the tabs we just moved.
  }
  // Layout was written as a bare string by the old app; accept JSON too.
  const lraw = ls.get('life_app_layout_v1');
  const lval = typeof parseJson(lraw) === 'string' ? (parseJson(lraw) as string) : lraw?.trim();
  const notes = (Array.isArray(parseJson(ls.get('life_app_notes_v1'))) ? (parseJson(ls.get('life_app_notes_v1')) as unknown[]) : []).filter(validNote) as NoteDocument[];
  const qlen = (k: string) => {
    const v = parseJson(ls.get(k));
    if (Array.isArray(v)) return v.length;
    if (v && typeof v === 'object') return Object.values(v).reduce<number>((n, x) => n + (Array.isArray(x) ? x.length : 0), 0);
    return 0;
  };
  let cookieRows: Array<Record<string, unknown>> = [];
  const cdb = path.join(dir, 'webkit_cookies.sqlite');
  if (fs.existsSync(cdb)) {
    try {
      cookieRows = await readMozCookieRows(cdb, 'old WebKit');
    } catch (e) {
      log('cookie jar unreadable:', String((e as Error).message).slice(0, 100));
    }
  }
  const dashKey = (k: string) => parseJson(ls.get(`lifeapp.dash.${k}`));
  return {
    workspaces: cleanWorkspaces(parseJson(ls.get('life_app_workspaces_v1'))),
    notes,
    prefs,
    layout: MODES.includes(lval as LayoutMode) ? (lval as LayoutMode) : null,
    dash: { links: dashKey('links'), notes: dashKey('notes'), recent: dashKey('recent') },
    queues: { sync: qlen('life_app_sync_queue_v1'), telemetry: qlen('life_app_telemetry_queue_v1') },
    cookieRows,
    logins: readLoginsIndex(dir),
  };
}

// ---------------------------------------------------------------------------------------------
// Merging state

export interface StateMerge {
  next: PersistedState;
  replaced: boolean;
  tabs: number;
  folders: number;
  notes: number;
}

const newId = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;
const ts = (iso: string | undefined) => {
  const t = Date.parse(iso ?? '');
  return Number.isNaN(t) ? 0 : t;
};
export const normUrl = (u: string | undefined) => (u ?? '').trim().replace(/#.*$/, '').replace(/\/+$/, '').toLowerCase();
const tabKey = (t: WorkspaceTab, folderId: string | undefined) => `${t.type === 'note' ? `note:${t.noteId ?? t.title}` : normUrl(t.url)}|${folderId ?? ''}`;
const countTabs = (ws: WorkspaceManifest[]) => ws.reduce((n, w) => n + w.tabs.filter((t) => t.type !== 'dashboard').length, 0);

export function mergeState(cur: PersistedState, old: OldData, replaceAllowed: boolean): StateMerge {
  const userFolders = cur.workspaces.some((w) => (w.folders?.length ?? 0) > 0);
  const replace = replaceAllowed && old.workspaces.length > 0 && !userFolders && cur.workspaces.reduce((n, w) => n + w.tabs.length, 0) <= 5;
  let workspaces: WorkspaceManifest[];
  let tabs = 0;
  let folders = 0;
  if (replace) {
    workspaces = old.workspaces.map(withDashboard);
    tabs = countTabs(old.workspaces);
    folders = old.workspaces.reduce((n, w) => n + (w.folders?.length ?? 0), 0);
  } else {
    workspaces = cur.workspaces.map((w) => ({ ...w, tabs: [...w.tabs], folders: [...(w.folders ?? [])] }));
    const usedTabIds = new Set(workspaces.flatMap((w) => w.tabs.map((t) => t.id)));
    const usedFolderIds = new Set(workspaces.flatMap((w) => (w.folders ?? []).map((f) => f.id)));
    for (const ow of old.workspaces) {
      let target = workspaces.find((w) => w.id === ow.id) ?? workspaces.find((w) => w.name.trim().toLowerCase() === ow.name.trim().toLowerCase());
      const fresh = !target;
      if (!target) {
        target = { ...ow, tabs: [], folders: [], primaryTabId: null, secondaryTabId: null, layout: 'single' };
        if (workspaces.some((w) => w.id === target!.id)) target.id = newId('ws');
        workspaces.push(target);
      }
      const t = target;
      // Folders: reuse a same-named folder, else add (fresh id on a clash).
      const fmap = new Map<string, string>();
      for (const f of ow.folders ?? []) {
        const same = (t.folders ?? []).find((x) => x.name.trim().toLowerCase() === f.name.trim().toLowerCase());
        if (same) {
          fmap.set(f.id, same.id);
          continue;
        }
        const id = usedFolderIds.has(f.id) ? newId('fld') : f.id;
        usedFolderIds.add(id);
        t.folders = [...(t.folders ?? []), { ...f, id }];
        fmap.set(f.id, id);
        folders++;
      }
      const have = new Set(t.tabs.map((x) => tabKey(x, x.folderId)));
      for (const ot of ow.tabs) {
        if (ot.type === 'dashboard') continue;
        const folderId = ot.folderId ? fmap.get(ot.folderId) : undefined;
        const k = tabKey(ot, folderId);
        if (have.has(k)) continue;
        have.add(k);
        const id = usedTabIds.has(ot.id) ? newId('tab') : ot.id;
        usedTabIds.add(id);
        t.tabs.push({ ...ot, id, ...(folderId ? { folderId } : { folderId: undefined }) });
        tabs++;
        if (fresh && ow.primaryTabId === ot.id) t.primaryTabId = id;
      }
      if (fresh) t.primaryTabId = t.primaryTabId ?? t.tabs[0]?.id ?? null;
      if (tabs || folders) t.updatedAt = new Date().toISOString();
    }
    workspaces = workspaces.map(withDashboard);
  }
  // Notes: by id, newer updatedAt wins (ties keep what is already here).
  const notes = [...cur.notes];
  let noteChanges = 0;
  for (const on of old.notes) {
    const at = notes.findIndex((n) => n.id === on.id);
    if (at < 0) {
      notes.push(on);
      noteChanges++;
    } else if (ts(on.updatedAt) > ts(notes[at].updatedAt)) {
      notes[at] = on;
      noteChanges++;
    }
  }
  const next: PersistedState = { ...cur, workspaces, notes };
  // Prefs/layout: adopt the old value only where the current one is still the default (never clobber a choice made here).
  const p = old.prefs;
  for (const k of ['showTopBar', 'autoHideAddressBar', 'showFolders', 'blockingEnabled'] as const) if (typeof p[k] === 'boolean' && cur[k] === DEFAULT_PREFS[k]) next[k] = p[k] as boolean;
  if (p.zenBarPosition && cur.zenBarPosition === DEFAULT_PREFS.zenBarPosition) next.zenBarPosition = p.zenBarPosition;
  if (old.layout && cur.layoutMode === 'left-vertical') next.layoutMode = old.layout;
  if (p.blockingDisabledSites?.length) next.blockingDisabledSites = cleanSites([...cur.blockingDisabledSites, ...p.blockingDisabledSites]);
  if (!next.workspaces.some((w) => w.id === next.activeWorkspaceId)) next.activeWorkspaceId = next.workspaces[0].id;
  return { next, replaced: replace, tabs, folders, notes: noteChanges };
}

// ---------------------------------------------------------------------------------------------
// Orchestration

export interface MigrationReport {
  ok: boolean;
  firstRun: boolean;
  replaced: boolean;
  tabs: number;
  folders: number;
  notes: number;
  cookies: { found: number; imported: number; skipped: number };
  logins: { found: number; withPassword: number; usernamesOnly: number; needReentry: number };
  skippedQueues: { sync: number; telemetry: number };
  errors: string[];
  at: string;
}

export interface StateIO {
  get(): PersistedState;
  apply(next: PersistedState): void | Promise<void>;
}

/** Reads/writes jivvy-state.json directly: for startup, before the StateStore exists. */
export function fileStateIO(userData: string): StateIO {
  const file = path.join(userData, STATE_FILE);
  return {
    get() {
      try {
        return hydrate(JSON.parse(fs.readFileSync(file, 'utf8')));
      } catch {
        return hydrate(null);
      }
    },
    apply(next) {
      fs.mkdirSync(userData, { recursive: true });
      const tmp = `${file}.${process.pid}.mig.tmp`;
      const fd = fs.openSync(tmp, 'w', 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(next), 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, file);
    },
  };
}

export interface MigrateOptions {
  userData: string;
  oldDir: string;
  session: () => Session;
  logins: Logins;
  state: StateIO;
  /** Tests inject a fake keyring reader. */
  readPasswords?: PasswordReader;
}

export function shouldAutoMigrate(userData: string, oldDir: string): boolean {
  return fs.existsSync(oldDir) && !fs.existsSync(path.join(userData, MARKER)) && !process.env.JIVVY_NO_MIGRATE;
}

export function backupState(userData: string): string | null {
  const files = [STATE_FILE, LOGINS_FILE].filter((f) => fs.existsSync(path.join(userData, f)));
  if (!files.length) return null;
  const dir = path.join(userData, `backup-before-migration-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const f of files) fs.copyFileSync(path.join(userData, f), path.join(dir, f));
  return dir;
}

export function summaryText(r: Pick<MigrationReport, 'tabs' | 'notes' | 'logins'>): string {
  return `Moved ${r.tabs} tabs, ${r.notes} notes, ${r.logins.withPassword + r.logins.usernamesOnly} logins from the old Jivvy`;
}

/** Run the migration (or re-run it: merging again is safe). Writes the marker last. */
export async function runMigration(o: MigrateOptions): Promise<MigrationReport> {
  const markerFile = path.join(o.userData, MARKER);
  let prior: { firstAt?: string; runs?: number } | null = null;
  try {
    prior = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
  } catch {
    /* first run */
  }
  const firstRun = !prior;
  const errors: string[] = [];
  const old = await readOldData(o.oldDir); // throws: nothing has been changed yet, no marker is written
  backupState(o.userData);

  // 1. state
  const cur = o.state.get();
  const m = mergeState(cur, old, firstRun);
  await o.state.apply(m.next);

  // 2. dashboard keys: the dashboard lives in the renderer's localStorage; main hands it over once.
  try {
    const d = old.dash;
    if (d.links !== undefined || d.notes !== undefined || d.recent !== undefined) {
      fs.writeFileSync(path.join(o.userData, DASH_PENDING), JSON.stringify(d), { mode: 0o600 });
    }
  } catch (e) {
    errors.push(`dashboard: ${String((e as Error).message).slice(0, 80)}`);
  }

  // 3. cookies: never overwrite what is already in the live store.
  const cookies = { found: old.cookieRows.length, imported: 0, skipped: 0 };
  try {
    const r = await importMozCookieRows(o.session(), old.cookieRows, { overwrite: false });
    cookies.imported = r.imported;
    cookies.skipped = r.skipped;
  } catch (e) {
    errors.push(`cookies: ${String((e as Error).message).slice(0, 80)}`);
  }

  // 4. logins: usernames always, passwords when the old keyring reads without a prompt.
  const logins = { found: old.logins.length, withPassword: 0, usernamesOnly: 0, needReentry: 0 };
  try {
    let secrets: Map<string, string> | undefined;
    if (old.logins.length && o.logins.keyringUsable()) {
      const pr = await (o.readPasswords ?? readSecretServicePasswords)(true);
      secrets = pr.secrets;
      if (pr.error) errors.push(`passwords: ${pr.error}`);
      else if (pr.locked) errors.push(`passwords: ${pr.locked} in a locked keyring`);
    } else if (old.logins.length) errors.push('passwords: no secure keyring here to store them');
    const items = new Map<string, { host: string; username: string; password: string | null }>();
    for (const l of old.logins) {
      const k = `${l.host}\u0000${l.username}`;
      const pw = secrets?.get(`${l.origin}|${l.username}`) ?? null;
      const prev = items.get(k);
      if (!prev) items.set(k, { host: l.host, username: l.username, password: pw });
      else if (!prev.password && pw) prev.password = pw;
    }
    const r = o.logins.importMigrated([...items.values()]);
    logins.withPassword = r.withPassword;
    logins.usernamesOnly = r.usernamesOnly;
    logins.needReentry = r.usernamesOnly;
  } catch (e) {
    errors.push(`logins: ${String((e as Error).message).slice(0, 80)}`);
  }

  const report: MigrationReport = {
    ok: errors.length === 0,
    firstRun,
    replaced: m.replaced,
    tabs: m.tabs,
    folders: m.folders,
    notes: m.notes,
    cookies,
    logins,
    skippedQueues: old.queues,
    errors,
    at: new Date().toISOString(),
  };
  // Marker last. Counts accumulate across re-runs so the first toast numbers stay meaningful.
  const first = (prior as { first?: unknown } | null)?.first ?? { tabs: report.tabs, notes: report.notes, logins: report.logins.withPassword + report.logins.usernamesOnly };
  const marker = { ...report, first, firstAt: prior?.firstAt ?? report.at, runs: (prior?.runs ?? 0) + 1 };
  fs.writeFileSync(markerFile, JSON.stringify(marker, null, 1), { mode: 0o600 });
  log(
    `done tabs=${report.tabs} folders=${report.folders} notes=${report.notes} cookies=${cookies.imported}/${cookies.found} (skipped ${cookies.skipped}) ` +
      `logins=${logins.withPassword} with password + ${logins.usernamesOnly} username-only of ${logins.found}; skipped queues sync=${old.queues.sync} telemetry=${old.queues.telemetry}` +
      (errors.length ? ` notes: ${errors.join('; ')}` : '')
  );
  return report;
}

/** Startup: only when the old dir exists, there is no marker and JIVVY_NO_MIGRATE is unset. Never throws. */
export async function autoMigrate(o: MigrateOptions): Promise<MigrationReport | null> {
  if (!shouldAutoMigrate(o.userData, o.oldDir)) return null;
  try {
    return await runMigration(o);
  } catch (e) {
    log('skipped, will retry next start:', String((e as Error).message).slice(0, 120));
    return null;
  }
}

/** Renderer asks once for the dashboard keys to merge into its localStorage. */
export function takeMigratedDash(userData: string): { links?: unknown; notes?: unknown; recent?: unknown } | null {
  const f = path.join(userData, DASH_PENDING);
  try {
    const v = JSON.parse(fs.readFileSync(f, 'utf8'));
    fs.rmSync(f, { force: true });
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Dry run: parse everything, print counts only.

export interface DryRunCounts {
  tabs: number;
  folders: number;
  workspaces: number;
  notes: number;
  cookiesFound: number;
  cookiesUsable: number;
  loginsFound: number;
  passwordsReadable: number;
  passwordsLocked: number;
  queues: { sync: number; telemetry: number };
  passwordError?: string;
}

export async function dryRun(oldDir: string, readPasswords: PasswordReader = readSecretServicePasswords): Promise<DryRunCounts> {
  const old = await readOldData(oldDir);
  const { raws } = classifyMozCookieRows(old.cookieRows);
  const pr = old.logins.length ? await readPasswords(false) : { found: 0, readable: 0, locked: 0 };
  return {
    tabs: countTabs(old.workspaces),
    folders: old.workspaces.reduce((n, w) => n + (w.folders?.length ?? 0), 0),
    workspaces: old.workspaces.length,
    notes: old.notes.length,
    cookiesFound: old.cookieRows.length,
    cookiesUsable: raws.filter((c) => c.plain).length,
    loginsFound: old.logins.length,
    passwordsReadable: pr.readable,
    passwordsLocked: pr.locked,
    queues: old.queues,
    passwordError: pr.error,
  };
}
