// The workspace state machine, shared by the renderer (Tauri / browser builds) and the Electron
// main process (single source of truth). `reduce` is pure apart from timestamps and the odd
// generated id, so both sides produce identical results for the same action.

import type { ImportedWorkspaceGroup, NoteDocument, TabFolder, WorkspaceManifest, WorkspaceTab, TabType } from './types';
import type { LayoutMode, ZenBarPosition } from './layout';

export const EPOCH = '1970-01-01T00:00:00.000Z';
export const MAX_BLOCK_SITES = 500;
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/;

/** Normalize a URL or host to a bare lowercase hostname, or null if it is not a valid domain. */
export function normalizeHost(input: string): string | null {
  let s = (input || '').trim().toLowerCase();
  if (!s) return null;
  if (!s.includes('://')) s = `https://${s}`;
  let host: string;
  try {
    host = new URL(s).hostname;
  } catch {
    return null;
  }
  host = host.replace(/^www\./, '').replace(/\.$/, '');
  return DOMAIN_RE.test(host) ? host : null;
}

export interface Prefs {
  showTopBar: boolean;
  clearTabsOnStart: boolean;
  autoHideAddressBar: boolean;
  showFolders: boolean;
  zenBarPosition: ZenBarPosition;
  blockingEnabled: boolean;
  blockingDisabledSites: string[];
  /** Keep a local browsing history (powers suggestions). Off = record nothing. */
  saveHistory: boolean;
  /** Memory saver: put background tabs to sleep after this many minutes (0 = never). */
  sleepAfterMin: number;
  /** Memory saver: at most this many tabs keep a live page; least recently used ones sleep. */
  maxAwakeTabs: number;
  /** Memory saver: sleep background tabs when the machine runs low on free memory (Linux). */
  memoryGuard: boolean;
  /** Memory saver: pinned tabs never sleep. */
  keepPinnedAwake: boolean;
}

export const SLEEP_AFTER_OPTIONS = [5, 15, 30, 60, 0] as const;
export const MAX_AWAKE_MIN = 2;
export const MAX_AWAKE_MAX = 20;

export type PermDecision = 'allow' | 'block';
/** The powerful permissions a site may ask for (camera and microphone are split out of Chromium's `media`). */
export const PROMPT_PERMISSIONS = ['camera', 'microphone', 'geolocation', 'notifications', 'clipboard-read', 'midi'] as const;
export type PromptPermission = (typeof PROMPT_PERMISSIONS)[number];
/** origin -> permission -> the user's remembered answer. */
export type SitePermissions = Record<string, Partial<Record<PromptPermission, PermDecision>>>;
export const MAX_SITE_ENTRIES = 500;
export const ZOOM_MIN = 25;
export const ZOOM_MAX = 500;

export interface PersistedState extends Prefs {
  workspaces: WorkspaceManifest[];
  activeWorkspaceId: string;
  notes: NoteDocument[];
  layoutMode: LayoutMode;
  /** Page zoom in percent by host (100 = absent). */
  siteZoom: Record<string, number>;
  sitePermissions: SitePermissions;
}

export const PERSISTED_KEYS: Array<keyof PersistedState> = [
  'workspaces',
  'activeWorkspaceId',
  'notes',
  'layoutMode',
  'siteZoom',
  'sitePermissions',
  'showTopBar',
  'clearTabsOnStart',
  'autoHideAddressBar',
  'showFolders',
  'zenBarPosition',
  'blockingEnabled',
  'blockingDisabledSites',
  'saveHistory',
  'sleepAfterMin',
  'maxAwakeTabs',
  'memoryGuard',
  'keepPinnedAwake',
];

export const DEFAULT_PREFS: Prefs = {
  showTopBar: true,
  clearTabsOnStart: false,
  autoHideAddressBar: true,
  showFolders: true,
  zenBarPosition: 'left',
  blockingEnabled: true,
  blockingDisabledSites: [],
  saveHistory: true,
  sleepAfterMin: 30,
  maxAwakeTabs: 6,
  memoryGuard: true,
  keepPinnedAwake: true,
};

const nowIso = () => new Date().toISOString();
const rid = (p: string) => `${p}_${globalThis.crypto.randomUUID().slice(0, 8)}`;

export function defaultWorkspaces(): WorkspaceManifest[] {
  const now = nowIso();
  return [
    {
      id: 'ws_dashboard',
      name: 'Dashboard',
      contextTag: 'dashboard',
      layout: 'single',
      primaryTabId: 'tab_dashboard',
      secondaryTabId: null,
      updatedAt: EPOCH,
      tabs: [
        { id: 'tab_dashboard', title: 'Dashboard', type: 'dashboard', pinned: true, lastActiveAt: now },
        { id: 'tab_jivvy', title: 'Jivvy Study', type: 'jivvy', url: 'https://jivvy-study.vercel.app/', pinned: true, lastActiveAt: now },
        { id: 'tab_welcome_note', title: 'Welcome Note', type: 'note', noteId: 'note_welcome', lastActiveAt: now },
      ],
    },
  ];
}

export function defaultNotes(): NoteDocument[] {
  return [
    {
      id: 'note_welcome',
      title: 'Welcome Note',
      content: '# Jivvy Life\n\nYour unified workspace shell is live.\n\nTry linking to [[Study Plan]] or importing your Firefox bookmarks.',
      tags: ['alpha', 'dashboard'],
      wikilinks: ['Study Plan'],
      updatedAt: EPOCH,
    },
  ];
}

export const withDashboard = (ws: WorkspaceManifest): WorkspaceManifest =>
  ws.tabs.some((t) => t.type === 'dashboard')
    ? ws
    : {
        ...ws,
        tabs: [
          {
            id: ws.id === 'ws_dashboard' ? 'tab_dashboard' : `tab_dashboard_${ws.id}`,
            title: 'Dashboard',
            type: 'dashboard',
            pinned: true,
            lastActiveAt: nowIso(),
          },
          ...ws.tabs,
        ],
      };

const isKept = (t: WorkspaceTab) => !!t.pinned || t.type === 'dashboard';
export function clearedWorkspace(ws: WorkspaceManifest): WorkspaceManifest {
  const tabs = ws.tabs.filter(isKept);
  if (tabs.length === ws.tabs.length) return ws;
  const has = (id: string | null) => !!id && tabs.some((t) => t.id === id);
  const dash = tabs.find((t) => t.type === 'dashboard');
  const primaryTabId = has(ws.primaryTabId) ? ws.primaryTabId : (dash ?? tabs[0])?.id ?? null;
  return {
    ...ws,
    tabs,
    primaryTabId,
    secondaryTabId: has(ws.secondaryTabId) ? ws.secondaryTabId : null,
    layout: has(ws.secondaryTabId) ? ws.layout : 'single',
    updatedAt: nowIso(),
  };
}

export function cleanSites(v: unknown[]): string[] {
  return [...new Set(v.map((x) => normalizeHost(String(x))).filter((x): x is string => !!x))].slice(0, MAX_BLOCK_SITES);
}

const isPromptPerm = (v: unknown): v is PromptPermission => (PROMPT_PERMISSIONS as readonly unknown[]).includes(v);
const HOST_RE = /^[a-z0-9.\-[\]:]{1,253}$/;

function cleanZoom(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [h, p] of Object.entries(v as Record<string, unknown>)) {
    if (HOST_RE.test(h) && Number.isInteger(p) && (p as number) >= ZOOM_MIN && (p as number) <= ZOOM_MAX && p !== 100) out[h] = p as number;
    if (Object.keys(out).length >= MAX_SITE_ENTRIES) break;
  }
  return out;
}

function cleanPerms(v: unknown): SitePermissions {
  const out: SitePermissions = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [origin, perms] of Object.entries(v as Record<string, unknown>)) {
    if (origin.length > 300 || !perms || typeof perms !== 'object') continue;
    const clean: SitePermissions[string] = {};
    for (const [k, d] of Object.entries(perms as Record<string, unknown>)) if (isPromptPerm(k) && (d === 'allow' || d === 'block')) clean[k] = d;
    if (Object.keys(clean).length) out[origin] = clean;
    if (Object.keys(out).length >= MAX_SITE_ENTRIES) break;
  }
  return out;
}

/** Build a valid state from whatever was on disk (or nothing). */
export function hydrate(raw: Partial<PersistedState> | null | undefined): PersistedState {
  const r = raw && typeof raw === 'object' ? raw : {};
  let workspaces = (Array.isArray(r.workspaces) && r.workspaces.length ? r.workspaces : defaultWorkspaces()).map((w) =>
    withDashboard({ ...w, tabs: Array.isArray(w.tabs) ? w.tabs : [], folders: Array.isArray(w.folders) ? w.folders : [] })
  );
  const clearTabsOnStart = typeof r.clearTabsOnStart === 'boolean' ? r.clearTabsOnStart : DEFAULT_PREFS.clearTabsOnStart;
  if (clearTabsOnStart) workspaces = workspaces.map(clearedWorkspace);
  const modes: LayoutMode[] = ['left-vertical', 'compact-rail', 'classic-top', 'zen'];
  const bool = (k: keyof Prefs) => (typeof r[k] === 'boolean' ? (r[k] as boolean) : (DEFAULT_PREFS[k] as boolean));
  return {
    workspaces,
    activeWorkspaceId: workspaces.some((w) => w.id === r.activeWorkspaceId) ? (r.activeWorkspaceId as string) : workspaces[0].id,
    notes: Array.isArray(r.notes) ? r.notes : defaultNotes(),
    layoutMode: modes.includes(r.layoutMode as LayoutMode) ? (r.layoutMode as LayoutMode) : 'left-vertical',
    siteZoom: cleanZoom(r.siteZoom),
    sitePermissions: cleanPerms(r.sitePermissions),
    showTopBar: bool('showTopBar'),
    clearTabsOnStart,
    autoHideAddressBar: bool('autoHideAddressBar'),
    showFolders: bool('showFolders'),
    zenBarPosition: r.zenBarPosition === 'top' || r.zenBarPosition === 'bottom' ? r.zenBarPosition : 'left',
    blockingEnabled: bool('blockingEnabled'),
    blockingDisabledSites: Array.isArray(r.blockingDisabledSites) ? cleanSites(r.blockingDisabledSites) : [],
    saveHistory: bool('saveHistory'),
    sleepAfterMin: (SLEEP_AFTER_OPTIONS as readonly unknown[]).includes(r.sleepAfterMin) ? (r.sleepAfterMin as number) : DEFAULT_PREFS.sleepAfterMin,
    maxAwakeTabs: Number.isInteger(r.maxAwakeTabs) ? Math.min(MAX_AWAKE_MAX, Math.max(MAX_AWAKE_MIN, r.maxAwakeTabs as number)) : DEFAULT_PREFS.maxAwakeTabs,
    memoryGuard: bool('memoryGuard'),
    keepPinnedAwake: bool('keepPinnedAwake'),
  };
}

export type PrefKey = keyof Prefs;

export type NewTab = Omit<WorkspaceTab, 'lastActiveAt'>;

export type Action =
  | { type: 'setPref'; key: PrefKey; value: Prefs[PrefKey] }
  | { type: 'clearAllTabs' }
  | { type: 'navigateTab'; tabId: string; url: string; title?: string }
  | { type: 'syncTabFromPage'; tabId: string; url: string; title?: string }
  | { type: 'createFolder'; id: string; name: string }
  | { type: 'renameFolder'; folderId: string; name: string }
  | { type: 'deleteFolder'; folderId: string }
  | { type: 'toggleFolder'; folderId: string }
  | { type: 'moveTabToFolder'; tabId: string; folderId: string | null }
  | { type: 'setActiveWorkspace'; id: string }
  | { type: 'setLayoutMode'; mode: LayoutMode }
  | { type: 'toggleSplitPane' }
  | { type: 'openTab'; tab: NewTab; targetPane?: 'primary' | 'secondary'; background?: boolean }
  | { type: 'focusTab'; tabId: string; pane?: 'primary' | 'secondary' }
  | { type: 'closeTab'; tabId: string }
  | { type: 'togglePin'; tabId: string }
  | { type: 'updateNoteContent'; noteId: string; content: string }
  | { type: 'createNote'; note: NoteDocument; tabId: string }
  | { type: 'renameNote'; noteId: string; title: string }
  | { type: 'importData'; groups: ImportedWorkspaceGroup[]; notes: NoteDocument[] }
  | { type: 'applyPulled'; workspaces?: WorkspaceManifest[]; notes?: NoteDocument[]; layoutMode?: LayoutMode }
  | { type: 'setSiteZoom'; host: string; percent: number }
  | { type: 'setSitePermission'; origin: string; permission: PromptPermission; value: PermDecision }
  /** Settings -> Site permissions: forget one answer, or every answer for the origin. */
  | { type: 'removeSitePermission'; origin: string; permission?: PromptPermission }
  /** Main only: the Tauri-build migration hands over an already merged and validated slice of state. */
  | { type: 'applyMigration'; patch: Partial<PersistedState> };

/** Actions only the main process may issue (page events), never accepted over IPC. */
export const INTERNAL_ACTIONS = new Set<Action['type']>(['syncTabFromPage', 'setSiteZoom', 'setSitePermission', 'applyMigration']);

function mapActive(s: PersistedState, fn: (ws: WorkspaceManifest) => WorkspaceManifest): PersistedState {
  return { ...s, workspaces: s.workspaces.map((ws) => (ws.id === s.activeWorkspaceId ? fn(ws) : ws)) };
}

export function reduce(s: PersistedState, a: Action): PersistedState {
  switch (a.type) {
    case 'setPref': {
      if (a.key === 'blockingDisabledSites') return { ...s, blockingDisabledSites: cleanSites(a.value as string[]) };
      if (s[a.key] === a.value) return s;
      return { ...s, [a.key]: a.value };
    }
    case 'clearAllTabs':
      return mapActive(s, clearedWorkspace);
    case 'navigateTab': {
      const now = nowIso();
      return mapActive(s, (ws) => ({
        ...ws,
        tabs: ws.tabs.map((t) => (t.id === a.tabId ? { ...t, url: a.url, title: a.title ?? t.title, lastActiveAt: now } : t)),
        updatedAt: now,
      }));
    }
    // Page-driven updates (in-page navigation, title changes): no updatedAt bump, so redirects
    // don't trigger sync pushes.
    case 'syncTabFromPage': {
      let changed = false;
      const workspaces = s.workspaces.map((ws) => {
        if (!ws.tabs.some((t) => t.id === a.tabId)) return ws;
        return {
          ...ws,
          tabs: ws.tabs.map((t) => {
            if (t.id !== a.tabId || (t.type !== 'web' && t.type !== 'jivvy')) return t;
            const nextTitle = a.title && a.title.trim() ? a.title.trim() : t.title;
            if (t.url === a.url && t.title === nextTitle) return t;
            changed = true;
            return { ...t, url: a.url, title: nextTitle };
          }),
        };
      });
      return changed ? { ...s, workspaces } : s;
    }
    case 'createFolder':
      return mapActive(s, (ws) => ({
        ...ws,
        folders: [...(ws.folders ?? []), { id: a.id, name: a.name.trim() || 'New folder' } as TabFolder],
        updatedAt: nowIso(),
      }));
    case 'renameFolder': {
      const n = a.name.trim();
      if (!n) return s;
      return mapActive(s, (ws) => ({
        ...ws,
        folders: (ws.folders ?? []).map((f) => (f.id === a.folderId ? { ...f, name: n } : f)),
        updatedAt: nowIso(),
      }));
    }
    case 'deleteFolder':
      return mapActive(s, (ws) => ({
        ...ws,
        folders: (ws.folders ?? []).filter((f) => f.id !== a.folderId),
        tabs: ws.tabs.map((t) => (t.folderId === a.folderId ? { ...t, folderId: undefined } : t)),
        updatedAt: nowIso(),
      }));
    case 'toggleFolder':
      return mapActive(s, (ws) => ({
        ...ws,
        folders: (ws.folders ?? []).map((f) => (f.id === a.folderId ? { ...f, collapsed: !f.collapsed } : f)),
        updatedAt: nowIso(),
      }));
    case 'moveTabToFolder':
      return mapActive(s, (ws) => ({
        ...ws,
        tabs: ws.tabs.map((t) => (t.id === a.tabId ? { ...t, folderId: a.folderId ?? undefined } : t)),
        updatedAt: nowIso(),
      }));
    case 'setActiveWorkspace':
      if (!s.workspaces.some((w) => w.id === a.id) || s.activeWorkspaceId === a.id) return s;
      return { ...s, activeWorkspaceId: a.id };
    case 'setLayoutMode':
      return s.layoutMode === a.mode ? s : { ...s, layoutMode: a.mode };
    case 'toggleSplitPane':
      return mapActive(s, (ws) => {
        const nextLayout = ws.layout === 'single' ? 'split-vertical' : 'single';
        const fallbackSecondary = ws.tabs.find((t) => t.id !== ws.primaryTabId)?.id || null;
        return {
          ...ws,
          layout: nextLayout,
          secondaryTabId: nextLayout === 'split-vertical' ? ws.secondaryTabId || fallbackSecondary : null,
          updatedAt: nowIso(),
        };
      });
    case 'openTab': {
      const pane = a.targetPane ?? 'primary';
      const newTab: WorkspaceTab = { ...a.tab, lastActiveAt: nowIso() };
      return mapActive(s, (ws) => ({
        ...ws,
        tabs: [...ws.tabs, newTab],
        primaryTabId: pane === 'primary' && !a.background ? newTab.id : ws.primaryTabId,
        secondaryTabId: pane === 'secondary' ? newTab.id : ws.secondaryTabId,
        layout: pane === 'secondary' ? 'split-vertical' : ws.layout,
        updatedAt: nowIso(),
      }));
    }
    // Focus does NOT bump updatedAt so clicking tabs doesn't spam cloud sync pushes.
    case 'focusTab': {
      const pane = a.pane ?? 'primary';
      const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId);
      if (!ws || !ws.tabs.some((t) => t.id === a.tabId)) return s;
      if (pane === 'primary' && ws.primaryTabId === a.tabId) return s;
      if (pane === 'secondary' && ws.secondaryTabId === a.tabId && ws.layout === 'split-vertical') return s;
      return mapActive(s, (w) => ({
        ...w,
        primaryTabId: pane === 'primary' ? a.tabId : w.primaryTabId,
        secondaryTabId: pane === 'secondary' ? a.tabId : w.secondaryTabId,
        layout: pane === 'secondary' ? 'split-vertical' : w.layout,
      }));
    }
    case 'closeTab':
      return mapActive(s, (ws) => {
        if (!ws.tabs.some((t) => t.id === a.tabId)) return ws;
        const remaining = ws.tabs.filter((t) => t.id !== a.tabId);
        return {
          ...ws,
          tabs: remaining,
          primaryTabId: ws.primaryTabId === a.tabId ? remaining[0]?.id || null : ws.primaryTabId,
          secondaryTabId: ws.secondaryTabId === a.tabId ? null : ws.secondaryTabId,
          updatedAt: nowIso(),
        };
      });
    case 'togglePin':
      return mapActive(s, (ws) => ({
        ...ws,
        tabs: ws.tabs.map((t) => (t.id === a.tabId ? { ...t, pinned: !t.pinned } : t)),
        updatedAt: nowIso(),
      }));
    case 'updateNoteContent': {
      const wikilinks = Array.from(a.content.matchAll(/\[\[([^\]]+)\]\]/g)).map((m) => m[1]);
      const tags = Array.from(new Set(Array.from(a.content.matchAll(/(?:^|\s)#([\w-]+)/g)).map((m) => m[1].toLowerCase())));
      return {
        ...s,
        notes: s.notes.map((n) => (n.id === a.noteId ? { ...n, content: a.content, wikilinks, tags, updatedAt: nowIso() } : n)),
      };
    }
    case 'renameNote':
      return {
        ...s,
        notes: s.notes.map((n) => (n.id === a.noteId ? { ...n, title: a.title, updatedAt: nowIso() } : n)),
        workspaces: s.workspaces.map((w) => ({
          ...w,
          tabs: w.tabs.map((t) => (t.type === 'note' && t.noteId === a.noteId ? { ...t, title: a.title } : t)),
        })),
      };
    case 'createNote': {
      const withNote = { ...s, notes: [...s.notes, a.note] };
      return reduce(withNote, { type: 'openTab', tab: { id: a.tabId, title: a.note.title, type: 'note', noteId: a.note.id } });
    }
    case 'importData': {
      const now = nowIso();
      const newWorkspaces: WorkspaceManifest[] = a.groups
        .filter((g) => g.selected && g.tabs.length > 0)
        .map((g) => {
          const tabs: WorkspaceTab[] = g.tabs.map((t) => ({ id: rid('tab'), title: t.title, type: 'web', url: t.url, lastActiveAt: now }));
          return withDashboard({
            id: rid('ws'),
            name: g.folderName,
            contextTag: 'personal',
            layout: 'single',
            primaryTabId: tabs[0]?.id || null,
            secondaryTabId: null,
            tabs,
            updatedAt: now,
          });
        });
      return {
        ...s,
        workspaces: [...s.workspaces, ...newWorkspaces],
        notes: [...s.notes, ...a.notes],
        activeWorkspaceId: newWorkspaces[0]?.id || s.activeWorkspaceId,
      };
    }
    case 'setSiteZoom': {
      const { [a.host]: old, ...rest } = s.siteZoom;
      if (a.percent === 100) return old === undefined ? s : { ...s, siteZoom: rest };
      if (old === a.percent) return s;
      // Newest last; the oldest entries fall off at the cap.
      const entries = Object.entries({ ...rest, [a.host]: a.percent }).slice(-MAX_SITE_ENTRIES);
      return { ...s, siteZoom: Object.fromEntries(entries) };
    }
    case 'setSitePermission': {
      if (s.sitePermissions[a.origin]?.[a.permission] === a.value) return s;
      const { [a.origin]: _o, ...others } = s.sitePermissions;
      const entries = Object.entries({ ...others, [a.origin]: { ...(s.sitePermissions[a.origin] ?? {}), [a.permission]: a.value } }).slice(-MAX_SITE_ENTRIES);
      return { ...s, sitePermissions: Object.fromEntries(entries) };
    }
    case 'removeSitePermission': {
      const cur = s.sitePermissions[a.origin];
      if (!cur) return s;
      const { [a.origin]: _o, ...others } = s.sitePermissions;
      if (!a.permission) return { ...s, sitePermissions: others };
      const { [a.permission]: _p, ...left } = cur;
      return { ...s, sitePermissions: Object.keys(left).length ? { ...others, [a.origin]: left } : others };
    }
    case 'applyMigration': {
      const next = { ...s, ...a.patch };
      if (!next.workspaces.some((w) => w.id === next.activeWorkspaceId)) next.activeWorkspaceId = next.workspaces[0]?.id ?? s.activeWorkspaceId;
      return next;
    }
    case 'applyPulled': {
      const workspaces = a.workspaces ? a.workspaces.map(withDashboard) : s.workspaces;
      return {
        ...s,
        workspaces,
        notes: a.notes ?? s.notes,
        layoutMode: a.layoutMode ?? s.layoutMode,
        activeWorkspaceId: workspaces.some((w) => w.id === s.activeWorkspaceId) ? s.activeWorkspaceId : workspaces[0]?.id ?? s.activeWorkspaceId,
      };
    }
  }
}

// ---------------------------------------------------------------------------------------------
// IPC validation: every action from a renderer is checked field by field before it reaches
// `reduce`. Anything unexpected is dropped.

const MAX_STR = 4096;
const MAX_URL = 8192;
const MAX_NOTE = 2_000_000;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max = MAX_STR): v is string => typeof v === 'string' && v.length <= max;
const optStr = (v: unknown, max = MAX_STR) => v === undefined || str(v, max);
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_\-:.]{1,128}$/.test(v);
export const isValidId = id;
const TAB_TYPES: TabType[] = ['web', 'note', 'jivvy', 'dashboard'];
const MODES: LayoutMode[] = ['left-vertical', 'compact-rail', 'classic-top', 'zen'];

/** Only http(s) and about:blank may be loaded in a tab. */
export function isAllowedTabUrl(u: unknown): boolean {
  if (!str(u, MAX_URL)) return false;
  if (u === 'about:blank') return true;
  try {
    const p = new URL(u).protocol;
    return p === 'http:' || p === 'https:';
  } catch {
    return false;
  }
}

export function validNote(n: unknown): n is NoteDocument {
  return (
    isObj(n) && id(n.id) && str(n.title) && str(n.content, MAX_NOTE) && Array.isArray(n.tags) && n.tags.every((t) => str(t, 256)) &&
    Array.isArray(n.wikilinks) && n.wikilinks.every((t) => str(t, 512)) && str(n.updatedAt, 64) && optStr(n.contextId, 128)
  );
}

export function validTab(t: unknown): t is WorkspaceTab {
  if (!isObj(t) || !id(t.id) || !str(t.title) || !TAB_TYPES.includes(t.type as TabType)) return false;
  if (t.url !== undefined && !str(t.url, MAX_URL)) return false;
  if ((t.type === 'web' || t.type === 'jivvy') && t.url !== undefined && !isAllowedTabUrl(t.url)) return false;
  return (t.noteId === undefined || id(t.noteId)) && (t.pinned === undefined || typeof t.pinned === 'boolean') &&
    optStr(t.favicon, MAX_URL) && (t.folderId === undefined || id(t.folderId));
}

export function validWorkspace(w: unknown): w is WorkspaceManifest {
  return (
    isObj(w) && id(w.id) && str(w.name) && Array.isArray(w.tabs) && w.tabs.length <= 5000 &&
    w.tabs.every((t) => validTab({ ...(t as object), lastActiveAt: undefined })) &&
    (w.folders === undefined || (Array.isArray(w.folders) && w.folders.every((f) => isObj(f) && id(f.id) && str(f.name))))
  );
}

export function validateAction(x: unknown): Action | null {
  if (!isObj(x) || typeof x.type !== 'string') return null;
  const a = x as Record<string, unknown>;
  const pane = (p: unknown) => p === undefined || p === 'primary' || p === 'secondary';
  switch (a.type) {
    case 'setPref': {
      const k = a.key as PrefKey;
      if (!(k in DEFAULT_PREFS)) return null;
      if (k === 'zenBarPosition') return a.value === 'left' || a.value === 'top' || a.value === 'bottom' ? (a as Action) : null;
      if (k === 'blockingDisabledSites')
        return Array.isArray(a.value) && a.value.length <= MAX_BLOCK_SITES * 2 && a.value.every((v) => str(v, 300)) ? (a as Action) : null;
      if (k === 'sleepAfterMin') return (SLEEP_AFTER_OPTIONS as readonly unknown[]).includes(a.value) ? (a as Action) : null;
      if (k === 'maxAwakeTabs') return Number.isInteger(a.value) && (a.value as number) >= MAX_AWAKE_MIN && (a.value as number) <= MAX_AWAKE_MAX ? (a as Action) : null;
      return typeof a.value === 'boolean' ? (a as Action) : null;
    }
    case 'clearAllTabs':
    case 'toggleSplitPane':
      return { type: a.type };
    case 'navigateTab':
      return id(a.tabId) && isAllowedTabUrl(a.url) && optStr(a.title) ? (a as Action) : null;
    case 'createFolder':
      return id(a.id) && str(a.name, 256) ? (a as Action) : null;
    case 'renameFolder':
      return id(a.folderId) && str(a.name, 256) ? (a as Action) : null;
    case 'deleteFolder':
    case 'toggleFolder':
      return id(a.folderId) ? (a as Action) : null;
    case 'moveTabToFolder':
      return id(a.tabId) && (a.folderId === null || id(a.folderId)) ? (a as Action) : null;
    case 'setActiveWorkspace':
      return id(a.id) ? (a as Action) : null;
    case 'setLayoutMode':
      return MODES.includes(a.mode as LayoutMode) ? (a as Action) : null;
    case 'openTab': {
      if (!validTab({ ...(a.tab as object), lastActiveAt: undefined }) || !pane(a.targetPane) || (a.background !== undefined && typeof a.background !== 'boolean'))
        return null;
      const t = a.tab as WorkspaceTab;
      const tab: NewTab = { id: t.id, title: t.title, type: t.type };
      if (t.url !== undefined) tab.url = t.url;
      if (t.noteId !== undefined) tab.noteId = t.noteId;
      if (t.pinned !== undefined) tab.pinned = t.pinned;
      if (t.folderId !== undefined) tab.folderId = t.folderId;
      return { type: 'openTab', tab, targetPane: a.targetPane as 'primary' | 'secondary' | undefined, background: a.background as boolean | undefined };
    }
    case 'focusTab':
      return id(a.tabId) && pane(a.pane) ? (a as Action) : null;
    case 'closeTab':
    case 'togglePin':
      return id(a.tabId) ? (a as Action) : null;
    case 'updateNoteContent':
      return id(a.noteId) && str(a.content, MAX_NOTE) ? (a as Action) : null;
    case 'createNote':
      return validNote(a.note) && id(a.tabId) ? (a as Action) : null;
    case 'renameNote':
      return id(a.noteId) && str(a.title) ? (a as Action) : null;
    case 'importData':
      return Array.isArray(a.groups) && a.groups.length <= 2000 &&
        a.groups.every((g) => isObj(g) && str(g.folderName) && typeof g.selected === 'boolean' && Array.isArray(g.tabs) &&
          g.tabs.length <= 20000 && g.tabs.every((t) => isObj(t) && str(t.title) && isAllowedTabUrl(t.url))) &&
        Array.isArray(a.notes) && a.notes.length <= 20000 && a.notes.every(validNote)
        ? (a as Action)
        : null;
    case 'applyPulled':
      return (a.workspaces === undefined || (Array.isArray(a.workspaces) && a.workspaces.every(validWorkspace))) &&
        (a.notes === undefined || (Array.isArray(a.notes) && a.notes.every(validNote))) &&
        (a.layoutMode === undefined || MODES.includes(a.layoutMode as LayoutMode))
        ? (a as Action)
        : null;
    case 'setSiteZoom':
      return str(a.host, 253) && HOST_RE.test(a.host as string) && Number.isInteger(a.percent) && (a.percent as number) >= ZOOM_MIN && (a.percent as number) <= ZOOM_MAX ? (a as Action) : null;
    case 'setSitePermission':
      return str(a.origin, 300) && isPromptPerm(a.permission) && (a.value === 'allow' || a.value === 'block') ? (a as Action) : null;
    case 'removeSitePermission':
      return str(a.origin, 300) && (a.permission === undefined || isPromptPerm(a.permission)) ? (a as Action) : null;
    default:
      return null;
  }
}
