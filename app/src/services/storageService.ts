import { WorkspaceManifest, NoteDocument, LayoutMode } from '../types/workspace';
import { api, getSession, isSignedIn, API_CONFIG_EVENT, ApiError, SyncRow } from './apiClient';
import { telemetryService } from './telemetryService';

const KEYS = {
  WORKSPACES: 'life_app_workspaces_v1',
  NOTES: 'life_app_notes_v1',
  LAYOUT: 'life_app_layout_v1',
  PREFS_META: 'life_app_prefs_meta_v1', // { updatedAt, sidebarWidth }
  DEVICE: 'life_app_device_id_v1',
  SYNC_QUEUE: 'life_app_sync_queue_v1', // persisted dirty ids: { workspaces: [], notes: [], prefs: bool }
  PUSHED: 'life_app_sync_pushed_v1', // { workspaces: {id: updatedAt}, notes: {id: updatedAt} }
  CURSOR: 'life_app_sync_cursor_v1', // { userId, since } server-time cursor for /sync/pull
  STATUS: 'life_app_sync_status_v1', // { at, ok, message } last sync result (display only)
};

export const SYNC_STATUS_EVENT = 'jivvy:sync-status';
export interface SyncStatus {
  at?: string;
  ok?: boolean;
  message?: string;
}
export function getSyncStatus(): SyncStatus {
  return readJson<SyncStatus>(KEYS.STATUS, {});
}
function setSyncStatus(ok: boolean, message: string) {
  writeJson(KEYS.STATUS, { at: new Date().toISOString(), ok, message });
  window.dispatchEvent(new Event(SYNC_STATUS_EVENT));
}
const errMsg = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : 'Sync failed');

const LOCAL_WRITE_DEBOUNCE_MS = 300;
const SYNC_DEBOUNCE_MS = 2000;
const BATCH_SIZE = 50;

interface DirtyQueue {
  workspaces: string[];
  notes: string[];
  prefs: boolean;
}
type Versions = Record<string, string>;
interface Pushed {
  workspaces: Versions;
  notes: Versions;
}
export interface PulledState {
  workspaces?: WorkspaceManifest[];
  notes?: NoteDocument[];
  layoutMode?: LayoutMode;
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota / private mode: sync still works from memory */
  }
}
const ts = (iso: string | undefined) => {
  const t = Date.parse(iso ?? '');
  return Number.isNaN(t) ? 0 : t;
};

let deviceId = '';
function getDeviceId(): string {
  if (deviceId) return deviceId;
  try {
    deviceId = localStorage.getItem(KEYS.DEVICE) || '';
    if (!deviceId) {
      deviceId = `device_${crypto.randomUUID().slice(0, 8)}`;
      localStorage.setItem(KEYS.DEVICE, deviceId);
    }
  } catch {
    deviceId = 'laptop_primary';
  }
  return deviceId;
}

// ---- in-memory state ----
let latestWorkspaces: WorkspaceManifest[] = [];
let latestNotes: NoteDocument[] = [];
let wsLocalPending = false;
let notesLocalPending = false;
let wsLocalTimer: number | undefined;
let notesLocalTimer: number | undefined;
let syncTimer: number | undefined;
let flushing = false;
let flushAgain = false;
let pulling = false;
let initialised = false;
let pulledListener: ((s: PulledState) => void) | null = null;
// Electron: main persists workspaces/notes/layout; this module only does cloud sync bookkeeping.
let localPersistence = true;
let layoutModeSource: (() => LayoutMode) | null = null;

const pushed: Pushed = readJson<Pushed>(KEYS.PUSHED, { workspaces: {}, notes: {} });
const dirty: DirtyQueue = readJson<DirtyQueue>(KEYS.SYNC_QUEUE, { workspaces: [], notes: [], prefs: false });
const dirtyWs = new Set(dirty.workspaces);
const dirtyNotes = new Set(dirty.notes);
let dirtyPrefs = !!dirty.prefs;

function persistQueue() {
  writeJson(KEYS.SYNC_QUEUE, { workspaces: [...dirtyWs], notes: [...dirtyNotes], prefs: dirtyPrefs });
}
function persistPushed() {
  writeJson(KEYS.PUSHED, pushed);
}

function scheduleSync(delay = SYNC_DEBOUNCE_MS) {
  if (!isSignedIn()) return;
  window.clearTimeout(syncTimer);
  syncTimer = window.setTimeout(() => void storageService.flush(), delay);
}

function flushLocalWrites() {
  if (!localPersistence) {
    wsLocalPending = notesLocalPending = false;
    return;
  }
  if (wsLocalPending) {
    window.clearTimeout(wsLocalTimer);
    wsLocalPending = false;
    writeJson(KEYS.WORKSPACES, latestWorkspaces);
  }
  if (notesLocalPending) {
    window.clearTimeout(notesLocalTimer);
    notesLocalPending = false;
    writeJson(KEYS.NOTES, latestNotes);
  }
}

/** Mark rows whose updatedAt differs from the last version known to be on the server. */
function markChanged<T extends { id: string; updatedAt: string }>(
  rows: T[],
  known: Versions,
  set: Set<string>
): boolean {
  let any = false;
  for (const r of rows) {
    if (known[r.id] !== r.updatedAt && !set.has(r.id)) {
      set.add(r.id);
      any = true;
    }
  }
  return any;
}

const toRow = <T extends { id: string; updatedAt: string }>(r: T): SyncRow<T> => ({
  id: r.id,
  data: r,
  updatedAt: r.updatedAt,
});

type PrefsMeta = { updatedAt?: string; sidebarWidth?: number };

/** Unwrap a pulled row's data, normalising the fields the merge depends on. */
function rowToWs(r: SyncRow): WorkspaceManifest {
  const d = r.data as WorkspaceManifest;
  return { ...d, id: r.id, tabs: Array.isArray(d.tabs) ? d.tabs : [], folders: Array.isArray(d.folders) ? d.folders : [], updatedAt: new Date(r.updatedAt).toISOString() };
}
function rowToNote(r: SyncRow): NoteDocument {
  const d = r.data as NoteDocument;
  return { ...d, id: r.id, content: d.content ?? '', tags: d.tags ?? [], wikilinks: d.wikilinks ?? [], updatedAt: new Date(r.updatedAt).toISOString() };
}

/** A different account than the one the cursor/pushed-map belong to: start over so everything is pushed. */
function resetIfUserChanged() {
  const sess = getSession();
  if (!sess) return;
  const cur = readJson<{ userId?: string; since?: string }>(KEYS.CURSOR, {});
  if (cur.userId === sess.userId) return;
  writeJson(KEYS.CURSOR, { userId: sess.userId, since: '' });
  pushed.workspaces = {};
  pushed.notes = {};
  persistPushed();
  dirtyPrefs = true;
  markChanged(latestWorkspaces, pushed.workspaces, dirtyWs);
  markChanged(latestNotes, pushed.notes, dirtyNotes);
  persistQueue();
}

export const storageService = {
  /** Electron: turn off localStorage copies of state that main owns; layout comes from `source`. */
  setLocalPersistence(enabled: boolean, source: () => LayoutMode) {
    localPersistence = enabled;
    layoutModeSource = source;
  },

  /** Store registers to receive merged remote data (pull / realtime-less sync). */
  onPulled(cb: (s: PulledState) => void) {
    pulledListener = cb;
  },

  /** Call once after the store has loaded initial state. Safe when signed out / no backend. */
  init(workspaces: WorkspaceManifest[], notes: NoteDocument[]) {
    if (initialised) return;
    initialised = true;
    latestWorkspaces = workspaces;
    latestNotes = notes;
    // Anything that changed while the app was closed (or never synced) goes on the queue.
    const wsChanged = markChanged(workspaces, pushed.workspaces, dirtyWs);
    const notesChanged = markChanged(notes, pushed.notes, dirtyNotes);
    if (wsChanged || notesChanged) persistQueue();

    const resync = () => {
      void (async () => {
        await storageService.pull();
        await storageService.flush();
        void telemetryService.flush();
      })();
    };
    window.addEventListener('online', resync);
    // Base URL / session changed (sign in, sign out, 401): sync again if signed in.
    window.addEventListener(API_CONFIG_EVENT, () => {
      if (isSignedIn()) {
        resetIfUserChanged();
        resync();
      }
    });
    window.addEventListener('pagehide', flushLocalWrites);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushLocalWrites();
    });

    resetIfUserChanged();
    resync();
  },

  loadWorkspaces(): WorkspaceManifest[] | null {
    return readJson<WorkspaceManifest[] | null>(KEYS.WORKSPACES, null);
  },

  saveWorkspaces(workspaces: WorkspaceManifest[]) {
    latestWorkspaces = workspaces;
    wsLocalPending = true;
    window.clearTimeout(wsLocalTimer);
    wsLocalTimer = window.setTimeout(flushLocalWrites, LOCAL_WRITE_DEBOUNCE_MS);
    if (markChanged(workspaces, pushed.workspaces, dirtyWs)) {
      persistQueue();
      scheduleSync();
    }
  },

  loadNotes(): NoteDocument[] | null {
    return readJson<NoteDocument[] | null>(KEYS.NOTES, null);
  },

  saveNotes(notes: NoteDocument[]) {
    latestNotes = notes;
    notesLocalPending = true;
    window.clearTimeout(notesLocalTimer);
    notesLocalTimer = window.setTimeout(flushLocalWrites, LOCAL_WRITE_DEBOUNCE_MS);
    // Only rows whose updatedAt moved are queued: typing in one note never re-sends the rest.
    if (markChanged(notes, pushed.notes, dirtyNotes)) {
      persistQueue();
      scheduleSync();
    }
  },

  loadLayoutMode(): LayoutMode {
    if (layoutModeSource) return layoutModeSource();
    const saved = localStorage.getItem(KEYS.LAYOUT) as LayoutMode | null;
    return saved || 'left-vertical';
  },

  saveLayoutMode(mode: LayoutMode) {
    if (localPersistence) localStorage.setItem(KEYS.LAYOUT, mode);
    const meta = readJson<{ updatedAt?: string; sidebarWidth?: number }>(KEYS.PREFS_META, {});
    writeJson(KEYS.PREFS_META, { ...meta, updatedAt: new Date().toISOString() });
    dirtyPrefs = true;
    persistQueue();
    scheduleSync();
  },

  /** Manual "Sync now": pull, push, report status. */
  async syncNow() {
    resetIfUserChanged();
    await this.pull();
    await this.flush();
  },

  /** Push only dirty rows, batched. Failures leave rows on the persistent queue. */
  async flush() {
    if (!isSignedIn() || !navigator.onLine) return;
    if (flushing) {
      flushAgain = true;
      return;
    }
    flushing = true;
    try {
      flushLocalWrites();

      const wsIds = [...dirtyWs];
      const noteIds = [...dirtyNotes];
      const prefsDirty = dirtyPrefs;
      wsIds.forEach((id) => dirtyWs.delete(id));
      noteIds.forEach((id) => dirtyNotes.delete(id));
      dirtyPrefs = false;
      persistQueue();

      const requeue = (table: 'workspaces' | 'notes', ids: string[]) => {
        ids.forEach((id) => (table === 'workspaces' ? dirtyWs : dirtyNotes).add(id));
        persistQueue();
      };

      let failure: unknown = null;
      const pushTable = async <T extends { id: string; updatedAt: string }>(
        table: 'workspaces' | 'notes',
        ids: string[],
        source: T[]
      ) => {
        const rows = ids.map((id) => source.find((r) => r.id === id)).filter((r): r is T => !!r);
        for (let i = 0; i < rows.length; i += BATCH_SIZE) {
          const chunk = rows.slice(i, i + BATCH_SIZE);
          try {
            const res = await api.push({ [table]: chunk.map(toRow) });
            const ok = new Set(res.accepted?.[table] ?? chunk.map((r) => r.id));
            chunk.forEach((r) => {
              if (ok.has(r.id)) pushed[table][r.id] = r.updatedAt;
            });
            persistPushed();
            requeue(table, chunk.filter((r) => !ok.has(r.id)).map((r) => r.id));
          } catch (e) {
            failure = e;
            requeue(table, rows.slice(i).map((r) => r.id));
            return;
          }
        }
      };

      await pushTable('workspaces', wsIds, latestWorkspaces);
      if (!failure) await pushTable('notes', noteIds, latestNotes);
      else requeue('notes', noteIds);

      if (prefsDirty) {
        const meta = readJson<PrefsMeta>(KEYS.PREFS_META, {});
        try {
          await api.push({
            preferences: {
              data: { layoutMode: this.loadLayoutMode(), sidebarWidth: meta.sidebarWidth ?? 260 },
              updatedAt: meta.updatedAt ?? new Date().toISOString(),
            },
          });
        } catch (e) {
          failure = failure ?? e;
          dirtyPrefs = true;
          persistQueue();
        }
      }
      if (failure) setSyncStatus(false, errMsg(failure));
      else setSyncStatus(true, 'Synced');
      void telemetryService.flush();
    } catch (e) {
      // Unexpected error: recover dirty ids from the persisted pushed-diff.
      markChanged(latestWorkspaces, pushed.workspaces, dirtyWs);
      markChanged(latestNotes, pushed.notes, dirtyNotes);
      persistQueue();
      setSyncStatus(false, errMsg(e));
    } finally {
      flushing = false;
      if (flushAgain) {
        flushAgain = false;
        scheduleSync(500);
      } else if (dirtyWs.size || dirtyNotes.size || dirtyPrefs) {
        scheduleSync(15_000); // retry after failure
      }
    }
  },

  /** Pull rows changed since the cursor and merge last-write-wins on updatedAt. */
  async pull() {
    if (!isSignedIn() || !navigator.onLine || pulling) return;
    pulling = true;
    try {
      const cur = readJson<{ userId?: string; since?: string }>(KEYS.CURSOR, {});
      const res = await api.pull(cur.since || undefined);
      const out: PulledState = {};

      const wsLive = res.workspaces.filter((r) => !r.deleted);
      const noteLive = res.notes.filter((r) => !r.deleted);
      const wsMerged = mergeLww(latestWorkspaces, wsLive.map(rowToWs), res.workspaces.filter((r) => r.deleted), pushed.workspaces, dirtyWs);
      if (wsMerged.changed) {
        latestWorkspaces = wsMerged.rows;
        out.workspaces = wsMerged.rows;
        wsLocalPending = true;
      }
      const noteMerged = mergeLww(latestNotes, noteLive.map(rowToNote), res.notes.filter((r) => r.deleted), pushed.notes, dirtyNotes);
      if (noteMerged.changed) {
        latestNotes = noteMerged.rows;
        out.notes = noteMerged.rows;
        notesLocalPending = true;
      }

      if (res.preferences) {
        const meta = readJson<PrefsMeta>(KEYS.PREFS_META, {});
        const d = (res.preferences.data ?? {}) as { layoutMode?: LayoutMode; sidebarWidth?: number };
        if (ts(res.preferences.updatedAt) > ts(meta.updatedAt)) {
          if (d.layoutMode) {
            if (localPersistence) localStorage.setItem(KEYS.LAYOUT, d.layoutMode);
            out.layoutMode = d.layoutMode;
          }
          writeJson(KEYS.PREFS_META, {
            updatedAt: new Date(res.preferences.updatedAt).toISOString(),
            sidebarWidth: d.sidebarWidth ?? meta.sidebarWidth,
          });
        } else if (ts(res.preferences.updatedAt) < ts(meta.updatedAt)) {
          dirtyPrefs = true;
        }
      } else if (!cur.since) {
        dirtyPrefs = true; // first pull and nothing remote yet: push ours
      }

      writeJson(KEYS.CURSOR, { userId: getSession()?.userId ?? cur.userId, since: res.serverTime });
      persistPushed();
      persistQueue();
      flushLocalWrites();
      if ((out.workspaces || out.notes || out.layoutMode) && pulledListener) pulledListener(out);
      if (dirtyWs.size || dirtyNotes.size || dirtyPrefs) scheduleSync(500);
      else setSyncStatus(true, 'Synced');
    } catch (e) {
      setSyncStatus(false, errMsg(e)); // offline / bad config: stay local
    } finally {
      pulling = false;
    }
  },
};

function mergeLww<T extends { id: string; updatedAt: string }>(
  local: T[],
  remote: T[],
  tombstones: SyncRow[],
  known: Versions,
  dirtySet: Set<string>
): { rows: T[]; changed: boolean } {
  const byId = new Map(local.map((r) => [r.id, r]));
  let changed = false;
  for (const r of remote) {
    const l = byId.get(r.id);
    if (!l) {
      byId.set(r.id, r);
      known[r.id] = r.updatedAt;
      changed = true;
    } else if (ts(r.updatedAt) > ts(l.updatedAt)) {
      byId.set(r.id, r);
      known[r.id] = r.updatedAt;
      dirtySet.delete(r.id);
      changed = true;
    } else if (ts(r.updatedAt) === ts(l.updatedAt)) {
      known[r.id] = l.updatedAt; // identical: nothing to push
      dirtySet.delete(l.id);
    } else {
      dirtySet.add(l.id); // local newer: push
    }
  }
  // Tombstones: remove locally unless the local copy is newer than the deletion.
  for (const t of tombstones) {
    const l = byId.get(t.id);
    if (l && ts(l.updatedAt) <= ts(t.updatedAt)) {
      byId.delete(t.id);
      dirtySet.delete(t.id);
      delete known[t.id];
      changed = true;
    }
  }
  // Local-only rows that the server doesn't have yet
  const remoteIds = new Set(remote.map((r) => r.id));
  for (const l of local) if (!remoteIds.has(l.id) && byId.has(l.id) && known[l.id] !== l.updatedAt) dirtySet.add(l.id);
  return { rows: changed ? [...byId.values()] : local, changed };
}
