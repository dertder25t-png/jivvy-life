import { create } from 'zustand';
import {
  WorkspaceManifest,
  WorkspaceTab,
  NoteDocument,
  LayoutMode,
  ActivityContext,
  ImportedWorkspaceGroup,
} from '../types/workspace';
import { storageService } from '../services/storageService';
import { telemetryService } from '../services/telemetryService';
import { normalizeHost, pushBlocking, MAX_BLOCK_SITES } from '../services/blocking';
import { reduce, hydrate, type Action, type PersistedState, type Prefs } from '../../shared/state';
import type { InitPayload, RuntimeState, StatePatch } from '../../shared/ipc';
import { jivvy, isElectron, isOverlayRole, openOverlay, closeOverlay } from '../platform';

export type ZenBarPosition = 'left' | 'top' | 'bottom';

// In Electron the main process owns this state: actions are sent to it and every change comes
// back as a patch (the store is a thin mirror). Elsewhere (Tauri / browser) the same reducer
// runs here and the result is saved to localStorage, as before.

const UI_PREFS_KEY = 'life_app_ui_prefs_v1';
function loadUiPrefs(): Partial<Prefs> {
  try {
    const p = JSON.parse(localStorage.getItem(UI_PREFS_KEY) || '{}');
    return {
      ...p,
      blockingDisabledSites: Array.isArray(p.blockingDisabledSites)
        ? [...new Set<string>(p.blockingDisabledSites.map((x: unknown) => normalizeHost(String(x))).filter((x: string | null): x is string => !!x))].slice(0, MAX_BLOCK_SITES)
        : [],
    };
  } catch {
    return {};
  }
}
function saveUiPrefs(s: Prefs) {
  try {
    const { showTopBar, clearTabsOnStart, autoHideAddressBar, showFolders, zenBarPosition, blockingEnabled, blockingDisabledSites } = s;
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ showTopBar, clearTabsOnStart, autoHideAddressBar, showFolders, zenBarPosition, blockingEnabled, blockingDisabledSites }));
  } catch {
    /* ignore */
  }
}

interface WorkspaceState extends PersistedState {
  activeContext: ActivityContext;
  importModalOpen: boolean;
  settingsModalOpen: boolean;
  /** Transient (never persisted): tabs that have produced audio, keyed by tab id. */
  audioTabs: Record<string, { playing: boolean; muted: boolean }>;
  /** Electron only: per-tab runtime (loading, history, audio) and floating-UI state from main. */
  runtime: RuntimeState;
  setTabAudio: (tabId: string, patch: Partial<{ playing: boolean; muted: boolean }>) => void;
  clearTabAudio: (tabId: string) => void;

  setBlockingEnabled: (v: boolean) => void;
  setBlockingDisabledSites: (v: string[]) => void;
  setAutoHideAddressBar: (v: boolean) => void;
  setShowTopBar: (v: boolean) => void;
  setSaveHistory: (v: boolean) => void;
  setSleepAfterMin: (v: number) => void;
  setMaxAwakeTabs: (v: number) => void;
  setMemoryGuard: (v: boolean) => void;
  setKeepPinnedAwake: (v: boolean) => void;
  setClearTabsOnStart: (v: boolean) => void;
  setShowFolders: (v: boolean) => void;
  setZenBarPosition: (v: ZenBarPosition) => void;
  clearAllTabs: () => void;
  navigateTab: (tabId: string, url: string, title?: string) => void;
  syncTabFromPage: (tabId: string, url: string, title?: string) => void;
  createFolder: (name: string) => string;
  renameFolder: (folderId: string, name: string) => void;
  deleteFolder: (folderId: string) => void;
  toggleFolder: (folderId: string) => void;
  moveTabToFolder: (tabId: string, folderId: string | null) => void;
  setActiveWorkspace: (id: string) => void;
  setLayoutMode: (mode: LayoutMode) => void;
  toggleSplitPane: () => void;
  openTab: (tab: Omit<WorkspaceTab, 'id' | 'lastActiveAt'>, targetPane?: 'primary' | 'secondary') => void;
  focusTab: (tabId: string, pane?: 'primary' | 'secondary') => void;
  closeTab: (tabId: string) => void;
  togglePin: (tabId: string) => void;
  updateNoteContent: (noteId: string, content: string) => void;
  createNote: (title: string) => NoteDocument;
  renameNote: (noteId: string, title: string) => void;
  importData: (groups: ImportedWorkspaceGroup[], notes: NoteDocument[]) => void;
  setImportModalOpen: (open: boolean) => void;
  setSettingsModalOpen: (open: boolean) => void;
}

const EMPTY_RUNTIME: RuntimeState = { tabs: {}, fullscreenTabId: null, overlay: null, blocking: { ready: false, rules: 0 } };

// Electron gets its real state from main before the first render (see main.tsx).
const initial: PersistedState = isElectron
  ? hydrate(null)
  : hydrate({
      ...loadUiPrefs(),
      workspaces: storageService.loadWorkspaces() ?? undefined,
      notes: storageService.loadNotes() ?? undefined,
      layoutMode: storageService.loadLayoutMode(),
    });

const rid = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;

export const useWorkspaceStore = create<WorkspaceState>((set, get) => {
  /** Run an action: in Electron main applies it; elsewhere apply and persist locally. */
  const act = (a: Action) => {
    if (jivvy) {
      jivvy.dispatch(a);
      return;
    }
    const prev = get();
    const next = reduce(prev, a);
    if (next === prev) return;
    if (next.workspaces !== prev.workspaces) storageService.saveWorkspaces(next.workspaces);
    if (next.notes !== prev.notes) storageService.saveNotes(next.notes);
    if (next.layoutMode !== prev.layoutMode) storageService.saveLayoutMode(next.layoutMode);
    if (a.type === 'setPref') saveUiPrefs(next);
    if (next.blockingEnabled !== prev.blockingEnabled || next.blockingDisabledSites !== prev.blockingDisabledSites)
      pushBlocking(next.blockingEnabled, next.blockingDisabledSites);
    set(next);
  };
  const pref = <K extends keyof Prefs>(key: K) => (value: Prefs[K]) => act({ type: 'setPref', key, value });

  return {
    ...initial,
    activeContext: { id: 'ctx_general', label: 'General Focus', tag: 'dashboard' },
    importModalOpen: false,
    settingsModalOpen: false,
    audioTabs: {},
    runtime: EMPTY_RUNTIME,
    setTabAudio: (tabId, patch) =>
      set((s) => ({ audioTabs: { ...s.audioTabs, [tabId]: { ...(s.audioTabs[tabId] ?? { playing: false, muted: false }), ...patch } } })),
    clearTabAudio: (tabId) =>
      set((s) => {
        if (!(tabId in s.audioTabs)) return s;
        const { [tabId]: _gone, ...rest } = s.audioTabs;
        return { audioTabs: rest };
      }),

    setBlockingEnabled: pref('blockingEnabled'),
    setBlockingDisabledSites: (v) => act({ type: 'setPref', key: 'blockingDisabledSites', value: [...new Set(v)].slice(0, MAX_BLOCK_SITES) }),
    setAutoHideAddressBar: pref('autoHideAddressBar'),
    setShowTopBar: pref('showTopBar'),
    setSaveHistory: pref('saveHistory'),
    setSleepAfterMin: pref('sleepAfterMin'),
    setMaxAwakeTabs: pref('maxAwakeTabs'),
    setMemoryGuard: pref('memoryGuard'),
    setKeepPinnedAwake: pref('keepPinnedAwake'),
    setClearTabsOnStart: pref('clearTabsOnStart'),
    setShowFolders: pref('showFolders'),
    setZenBarPosition: pref('zenBarPosition'),

    clearAllTabs: () => act({ type: 'clearAllTabs' }),
    navigateTab: (tabId, url, title) => act({ type: 'navigateTab', tabId, url, title }),
    // Page-driven updates come from main in Electron; this is the Tauri path.
    syncTabFromPage: (tabId, url, title) => {
      if (!jivvy) act({ type: 'syncTabFromPage', tabId, url, title });
    },
    createFolder: (name) => {
      const id = rid('fld');
      act({ type: 'createFolder', id, name });
      return id;
    },
    renameFolder: (folderId, name) => act({ type: 'renameFolder', folderId, name }),
    deleteFolder: (folderId) => act({ type: 'deleteFolder', folderId }),
    toggleFolder: (folderId) => act({ type: 'toggleFolder', folderId }),
    moveTabToFolder: (tabId, folderId) => act({ type: 'moveTabToFolder', tabId, folderId }),
    setActiveWorkspace: (id) => {
      act({ type: 'setActiveWorkspace', id });
      telemetryService.log({ eventType: 'transition', workspaceId: id });
    },
    setLayoutMode: (mode) => act({ type: 'setLayoutMode', mode }),
    toggleSplitPane: () => act({ type: 'toggleSplitPane' }),
    openTab: (tabInput, targetPane = 'primary') => {
      const id = rid('tab');
      act({ type: 'openTab', tab: { ...tabInput, id }, targetPane });
      telemetryService.log({
        eventType: 'tab_focused',
        workspaceId: get().activeWorkspaceId,
        tabId: id,
        domain: tabInput.url ? (() => { try { return new URL(tabInput.url).hostname; } catch { return 'web'; } })() : tabInput.type,
      });
    },
    focusTab: (tabId, pane = 'primary') => act({ type: 'focusTab', tabId, pane }),
    closeTab: (tabId) => act({ type: 'closeTab', tabId }),
    togglePin: (tabId) => act({ type: 'togglePin', tabId }),
    updateNoteContent: (noteId, content) => {
      // Applied locally right away too, so the editor never waits on a round trip.
      if (jivvy) set({ notes: reduce(get(), { type: 'updateNoteContent', noteId, content }).notes });
      act({ type: 'updateNoteContent', noteId, content });
    },
    renameNote: (noteId, title) => act({ type: 'renameNote', noteId, title }),
    createNote: (title) => {
      const note: NoteDocument = { id: rid('note'), title, content: '', tags: [], wikilinks: [], updatedAt: new Date().toISOString() };
      act({ type: 'createNote', note, tabId: rid('tab') });
      return note;
    },
    importData: (groups, notes) => act({ type: 'importData', groups, notes }),

    setImportModalOpen: (open) => {
      if (jivvy) return open ? openOverlay({ kind: 'import' }) : closeOverlay();
      set({ importModalOpen: open });
    },
    setSettingsModalOpen: (open) => {
      if (jivvy) return open ? openOverlay({ kind: 'settings' }) : closeOverlay();
      set({ settingsModalOpen: open });
    },
  };
});

// ---- Electron mirror ------------------------------------------------------------------------

function applyRuntime(rt: RuntimeState): Partial<WorkspaceState> {
  const audioTabs: WorkspaceState['audioTabs'] = {};
  for (const [id, t] of Object.entries(rt.tabs)) if (t.audible || t.muted) audioTabs[id] = { playing: t.audible || t.muted, muted: t.muted };
  return {
    runtime: rt,
    audioTabs,
    settingsModalOpen: rt.overlay?.kind === 'settings',
    importModalOpen: rt.overlay?.kind === 'import',
  };
}

function applyPatch(p: StatePatch) {
  const cur = useWorkspaceStore.getState();
  const next: Partial<WorkspaceState> = { ...(p.persist ?? {}) };
  if (p.runtime) Object.assign(next, applyRuntime({ ...cur.runtime, ...p.runtime }));
  useWorkspaceStore.setState(next);
}

/** Electron: load main's state before the first render and mirror every change after. */
export async function bootstrapElectronStore(): Promise<void> {
  if (!jivvy) return;
  const init: InitPayload = await jivvy.init();
  useWorkspaceStore.setState({ ...init.state, ...applyRuntime(init.runtime) });
  jivvy.onPatch(applyPatch);
  if (isOverlayRole) return;
  // The base view runs cloud sync: it watches the mirrored state and feeds pulls back to main.
  storageService.setLocalPersistence(false, () => useWorkspaceStore.getState().layoutMode);
  storageService.onPulled((p) => jivvy!.dispatch({ type: 'applyPulled', ...p }));
  useWorkspaceStore.subscribe((s, prev) => {
    if (s.workspaces !== prev.workspaces) storageService.saveWorkspaces(s.workspaces);
    if (s.notes !== prev.notes) storageService.saveNotes(s.notes);
    if (s.layoutMode !== prev.layoutMode) storageService.saveLayoutMode(s.layoutMode);
  });
  storageService.init(init.state.workspaces, init.state.notes);
}

if (!isElectron) {
  storageService.onPulled((p) => {
    useWorkspaceStore.setState((st) => reduce(st, { type: 'applyPulled', ...p }));
  });
  storageService.init(initial.workspaces, initial.notes);
  pushBlocking(initial.blockingEnabled, initial.blockingDisabledSites);
}

export type { WorkspaceManifest };
