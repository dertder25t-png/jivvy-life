import { create } from 'zustand';
import {
  WorkspaceManifest,
  WorkspaceTab,
  NoteDocument,
  LayoutMode,
  ActivityContext,
  ImportedWorkspaceGroup,
  TabFolder,
} from '../types/workspace';
import { storageService } from '../services/storageService';
import { telemetryService } from '../services/telemetryService';

const EPOCH = '1970-01-01T00:00:00.000Z';
export type ZenBarPosition = 'left' | 'top' | 'bottom';

const DEFAULT_WORKSPACES: WorkspaceManifest[] = [
  {
    id: 'ws_dashboard',
    name: 'Dashboard',
    contextTag: 'dashboard',
    layout: 'single',
    primaryTabId: 'tab_dashboard',
    secondaryTabId: null,
    updatedAt: EPOCH,
    tabs: [
      {
        id: 'tab_dashboard',
        title: 'Dashboard',
        type: 'dashboard',
        pinned: true,
        lastActiveAt: new Date().toISOString(),
      },
      {
        id: 'tab_jivvy',
        title: 'Jivvy Study',
        type: 'jivvy',
        url: 'https://jivvy-study.vercel.app/',
        pinned: true,
        lastActiveAt: new Date().toISOString(),
      },
      {
        id: 'tab_welcome_note',
        title: 'Welcome Note',
        type: 'note',
        noteId: 'note_welcome',
        lastActiveAt: new Date().toISOString(),
      },
    ],
  },
];

const DEFAULT_NOTES: NoteDocument[] = [
  {
    id: 'note_welcome',
    title: 'Welcome Note',
    content: '# Jivvy Life\n\nYour unified workspace shell is live.\n\nTry linking to [[Study Plan]] or importing your Firefox bookmarks.',
    tags: ['alpha', 'dashboard'],
    wikilinks: ['Study Plan'],
    updatedAt: EPOCH,
  },
];

const UI_PREFS_KEY = 'life_app_ui_prefs_v1';
interface UiPrefs {
  showTopBar: boolean;
  clearTabsOnStart: boolean;
  autoHideAddressBar: boolean;
  showFolders: boolean;
  zenBarPosition: ZenBarPosition;
}
function loadUiPrefs(): UiPrefs {
  try {
    const p = JSON.parse(localStorage.getItem(UI_PREFS_KEY) || '{}');
    return {
      showTopBar: p.showTopBar ?? true,
      clearTabsOnStart: p.clearTabsOnStart ?? false,
      autoHideAddressBar: p.autoHideAddressBar ?? true,
      showFolders: p.showFolders ?? true,
      zenBarPosition: p.zenBarPosition === 'top' || p.zenBarPosition === 'bottom' ? p.zenBarPosition : 'left',
    };
  } catch {
    return { showTopBar: true, clearTabsOnStart: false, autoHideAddressBar: true, showFolders: true, zenBarPosition: 'left' };
  }
}
function saveUiPrefs(p: UiPrefs) {
  try {
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

const isKept = (t: WorkspaceTab) => !!t.pinned || t.type === 'dashboard';
function clearedWorkspace(ws: WorkspaceManifest): WorkspaceManifest {
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
    updatedAt: new Date().toISOString(),
  };
}

interface WorkspaceState {
  workspaces: WorkspaceManifest[];
  activeWorkspaceId: string;
  notes: NoteDocument[];
  layoutMode: LayoutMode;
  activeContext: ActivityContext;
  importModalOpen: boolean;
  settingsModalOpen: boolean;
  showTopBar: boolean;
  clearTabsOnStart: boolean;
  autoHideAddressBar: boolean;
  showFolders: boolean;
  zenBarPosition: ZenBarPosition;

  setAutoHideAddressBar: (v: boolean) => void;
  setShowTopBar: (v: boolean) => void;
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

const uiPrefs = loadUiPrefs();
const withDashboard = (ws: WorkspaceManifest): WorkspaceManifest =>
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
            lastActiveAt: new Date().toISOString(),
          },
          ...ws.tabs,
        ],
      };

let initialWorkspaces = (storageService.loadWorkspaces() || DEFAULT_WORKSPACES).map(withDashboard);
if (uiPrefs.clearTabsOnStart) initialWorkspaces = initialWorkspaces.map(clearedWorkspace);
const initialNotes = storageService.loadNotes() || DEFAULT_NOTES;

function persistUi(st: WorkspaceState, patch: Partial<UiPrefs>) {
  saveUiPrefs({
    showTopBar: patch.showTopBar ?? st.showTopBar,
    clearTabsOnStart: patch.clearTabsOnStart ?? st.clearTabsOnStart,
    autoHideAddressBar: patch.autoHideAddressBar ?? st.autoHideAddressBar,
    showFolders: patch.showFolders ?? st.showFolders,
    zenBarPosition: patch.zenBarPosition ?? st.zenBarPosition,
  });
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspaces: initialWorkspaces,
  activeWorkspaceId: initialWorkspaces[0]?.id || 'ws_dashboard',
  notes: initialNotes,
  layoutMode: storageService.loadLayoutMode(),
  activeContext: { id: 'ctx_general', label: 'General Focus', tag: 'dashboard' },
  importModalOpen: false,
  settingsModalOpen: false,
  showTopBar: uiPrefs.showTopBar,
  clearTabsOnStart: uiPrefs.clearTabsOnStart,
  autoHideAddressBar: uiPrefs.autoHideAddressBar,
  showFolders: uiPrefs.showFolders,
  zenBarPosition: uiPrefs.zenBarPosition,

  setAutoHideAddressBar: (v) => {
    persistUi(get(), { autoHideAddressBar: v });
    set({ autoHideAddressBar: v });
  },
  setShowTopBar: (v) => {
    persistUi(get(), { showTopBar: v });
    set({ showTopBar: v });
  },
  setClearTabsOnStart: (v) => {
    persistUi(get(), { clearTabsOnStart: v });
    set({ clearTabsOnStart: v });
  },
  setShowFolders: (v) => {
    persistUi(get(), { showFolders: v });
    set({ showFolders: v });
  },
  setZenBarPosition: (v) => {
    persistUi(get(), { zenBarPosition: v });
    set({ zenBarPosition: v });
  },

  clearAllTabs: () => {
    const { workspaces, activeWorkspaceId } = get();
    const updated = workspaces.map((w) => (w.id === activeWorkspaceId ? clearedWorkspace(w) : w));
    storageService.saveWorkspaces(updated);
    set({ workspaces: updated });
  },

  navigateTab: (tabId, url, title) => {
    const { workspaces, activeWorkspaceId } = get();
    const now = new Date().toISOString();
    const updated = workspaces.map((ws) =>
      ws.id !== activeWorkspaceId
        ? ws
        : {
            ...ws,
            tabs: ws.tabs.map((t) => (t.id === tabId ? { ...t, url, title: title ?? t.title, lastActiveAt: now } : t)),
            updatedAt: now,
          }
    );
    storageService.saveWorkspaces(updated);
    set({ workspaces: updated });
  },

  // Page-driven updates (in-page navigation, title changes). Saved locally, but no
  // updatedAt bump: every redirect would otherwise trigger a sync push.
  syncTabFromPage: (tabId, url, title) => {
    const { workspaces } = get();
    let changed = false;
    const updated = workspaces.map((ws) => {
      if (!ws.tabs.some((t) => t.id === tabId)) return ws;
      return {
        ...ws,
        tabs: ws.tabs.map((t) => {
          if (t.id !== tabId || t.type !== 'web') return t;
          const nextTitle = title && title.trim() ? title.trim() : t.title;
          if (t.url === url && t.title === nextTitle) return t;
          changed = true;
          return { ...t, url, title: nextTitle };
        }),
      };
    });
    if (!changed) return;
    storageService.saveWorkspaces(updated);
    set({ workspaces: updated });
  },

  createFolder: (name) => {
    const id = `fld_${crypto.randomUUID().slice(0, 8)}`;
    const { workspaces, activeWorkspaceId } = get();
    const updated = workspaces.map((ws) =>
      ws.id !== activeWorkspaceId
        ? ws
        : { ...ws, folders: [...(ws.folders ?? []), { id, name: name.trim() || 'New folder' } as TabFolder], updatedAt: new Date().toISOString() }
    );
    storageService.saveWorkspaces(updated);
    set({ workspaces: updated });
    return id;
  },

  renameFolder: (folderId, name) => {
    const n = name.trim();
    if (!n) return;
    const { workspaces, activeWorkspaceId } = get();
    const updated = workspaces.map((ws) =>
      ws.id !== activeWorkspaceId
        ? ws
        : { ...ws, folders: (ws.folders ?? []).map((f) => (f.id === folderId ? { ...f, name: n } : f)), updatedAt: new Date().toISOString() }
    );
    storageService.saveWorkspaces(updated);
    set({ workspaces: updated });
  },

  deleteFolder: (folderId) => {
    const { workspaces, activeWorkspaceId } = get();
    const updated = workspaces.map((ws) =>
      ws.id !== activeWorkspaceId
        ? ws
        : {
            ...ws,
            folders: (ws.folders ?? []).filter((f) => f.id !== folderId),
            tabs: ws.tabs.map((t) => (t.folderId === folderId ? { ...t, folderId: undefined } : t)),
            updatedAt: new Date().toISOString(),
          }
    );
    storageService.saveWorkspaces(updated);
    set({ workspaces: updated });
  },

  toggleFolder: (folderId) => {
    const { workspaces, activeWorkspaceId } = get();
    const updated = workspaces.map((ws) =>
      ws.id !== activeWorkspaceId
        ? ws
        : {
            ...ws,
            folders: (ws.folders ?? []).map((f) => (f.id === folderId ? { ...f, collapsed: !f.collapsed } : f)),
            updatedAt: new Date().toISOString(),
          }
    );
    storageService.saveWorkspaces(updated);
    set({ workspaces: updated });
  },

  moveTabToFolder: (tabId, folderId) => {
    const { workspaces, activeWorkspaceId } = get();
    const updated = workspaces.map((ws) =>
      ws.id !== activeWorkspaceId
        ? ws
        : {
            ...ws,
            tabs: ws.tabs.map((t) => (t.id === tabId ? { ...t, folderId: folderId ?? undefined } : t)),
            updatedAt: new Date().toISOString(),
          }
    );
    storageService.saveWorkspaces(updated);
    set({ workspaces: updated });
  },

  setActiveWorkspace: (id) => {
    set({ activeWorkspaceId: id });
    telemetryService.log({ eventType: 'transition', workspaceId: id });
  },

  setLayoutMode: (mode) => {
    storageService.saveLayoutMode(mode);
    set({ layoutMode: mode });
  },

  toggleSplitPane: () => {
    const { workspaces, activeWorkspaceId } = get();
    const updated = workspaces.map((ws) => {
      if (ws.id !== activeWorkspaceId) return ws;
      const nextLayout = ws.layout === 'single' ? 'split-vertical' : 'single';
      const fallbackSecondary = ws.tabs.find((t) => t.id !== ws.primaryTabId)?.id || null;
      return {
        ...ws,
        layout: nextLayout as 'single' | 'split-vertical',
        secondaryTabId: nextLayout === 'split-vertical' ? ws.secondaryTabId || fallbackSecondary : null,
        updatedAt: new Date().toISOString(),
      };
    });
    storageService.saveWorkspaces(updated);
    set({ workspaces: updated });
  },

  openTab: (tabInput, targetPane = 'primary') => {
    const { workspaces, activeWorkspaceId } = get();
    const newTab: WorkspaceTab = {
      ...tabInput,
      id: `tab_${crypto.randomUUID().slice(0, 8)}`,
      lastActiveAt: new Date().toISOString(),
    };
    const updated = workspaces.map((ws) => {
      if (ws.id !== activeWorkspaceId) return ws;
      return {
        ...ws,
        tabs: [...ws.tabs, newTab],
        primaryTabId: targetPane === 'primary' ? newTab.id : ws.primaryTabId,
        secondaryTabId: targetPane === 'secondary' ? newTab.id : ws.secondaryTabId,
        layout: targetPane === 'secondary' ? 'split-vertical' : ws.layout,
        updatedAt: new Date().toISOString(),
      };
    });
    storageService.saveWorkspaces(updated);
    set({ workspaces: updated });
    telemetryService.log({
      eventType: 'tab_focused',
      workspaceId: activeWorkspaceId,
      tabId: newTab.id,
      domain: newTab.url ? (() => { try { return new URL(newTab.url).hostname; } catch { return 'web'; } })() : newTab.type,
    });
  },

  // Focus does NOT bump updatedAt so clicking tabs doesn't spam cloud sync pushes.
  focusTab: (tabId, pane = 'primary') => {
    const { workspaces, activeWorkspaceId } = get();
    const ws = workspaces.find((w) => w.id === activeWorkspaceId);
    if (!ws) return;
    if (pane === 'primary' && ws.primaryTabId === tabId) return;
    if (pane === 'secondary' && ws.secondaryTabId === tabId && ws.layout === 'split-vertical') return;

    const updated = workspaces.map((w) => {
      if (w.id !== activeWorkspaceId) return w;
      return {
        ...w,
        primaryTabId: pane === 'primary' ? tabId : w.primaryTabId,
        secondaryTabId: pane === 'secondary' ? tabId : w.secondaryTabId,
        layout: pane === 'secondary' ? 'split-vertical' : w.layout,
      };
    });
    storageService.saveWorkspaces(updated);
    set({ workspaces: updated });
  },

  closeTab: (tabId) => {
    const { workspaces, activeWorkspaceId } = get();
    const updated = workspaces.map((ws) => {
      if (ws.id !== activeWorkspaceId) return ws;
      const remaining = ws.tabs.filter((t) => t.id !== tabId);
      return {
        ...ws,
        tabs: remaining,
        primaryTabId: ws.primaryTabId === tabId ? remaining[0]?.id || null : ws.primaryTabId,
        secondaryTabId: ws.secondaryTabId === tabId ? null : ws.secondaryTabId,
        updatedAt: new Date().toISOString(),
      };
    });
    storageService.saveWorkspaces(updated);
    set({ workspaces: updated });
  },

  togglePin: (tabId) => {
    const { workspaces, activeWorkspaceId } = get();
    const updated = workspaces.map((ws) =>
      ws.id !== activeWorkspaceId
        ? ws
        : {
            ...ws,
            tabs: ws.tabs.map((t) => (t.id === tabId ? { ...t, pinned: !t.pinned } : t)),
            updatedAt: new Date().toISOString(),
          }
    );
    storageService.saveWorkspaces(updated);
    set({ workspaces: updated });
  },

  updateNoteContent: (noteId, content) => {
    const wikilinks = Array.from(content.matchAll(/\[\[([^\]]+)\]\]/g)).map((m) => m[1]);
    const tags = Array.from(new Set(Array.from(content.matchAll(/(?:^|\s)#([\w-]+)/g)).map((m) => m[1].toLowerCase())));
    const updated = get().notes.map((n) =>
      n.id === noteId ? { ...n, content, wikilinks, tags, updatedAt: new Date().toISOString() } : n
    );
    storageService.saveNotes(updated);
    set({ notes: updated });
  },

  renameNote: (noteId, title) => {
    const notes = get().notes.map((n) => (n.id === noteId ? { ...n, title, updatedAt: new Date().toISOString() } : n));
    storageService.saveNotes(notes);
    const workspaces = get().workspaces.map((w) => ({
      ...w,
      tabs: w.tabs.map((t) => (t.type === 'note' && t.noteId === noteId ? { ...t, title } : t)),
    }));
    storageService.saveWorkspaces(workspaces);
    set({ notes, workspaces });
  },

  createNote: (title) => {
    const note: NoteDocument = {
      id: `note_${crypto.randomUUID().slice(0, 8)}`,
      title,
      content: '',
      tags: [],
      wikilinks: [],
      updatedAt: new Date().toISOString(),
    };
    const updated = [...get().notes, note];
    storageService.saveNotes(updated);
    set({ notes: updated });
    get().openTab({ title, type: 'note', noteId: note.id });
    return note;
  },

  importData: (groups, importedNotes) => {
    const now = new Date().toISOString();
    const newWorkspaces: WorkspaceManifest[] = groups
      .filter((g) => g.selected && g.tabs.length > 0)
      .map((g) => {
        const tabs: WorkspaceTab[] = g.tabs.map((t) => ({
          id: `tab_${crypto.randomUUID().slice(0, 8)}`,
          title: t.title,
          type: 'web',
          url: t.url,
          lastActiveAt: now,
        }));
        return {
          id: `ws_${crypto.randomUUID().slice(0, 8)}`,
          name: g.folderName,
          contextTag: 'personal',
          layout: 'single',
          primaryTabId: tabs[0]?.id || null,
          secondaryTabId: null,
          tabs,
          updatedAt: now,
        };
      });

    const mergedWorkspaces = [...get().workspaces, ...newWorkspaces];
    const mergedNotes = [...get().notes, ...importedNotes];
    storageService.saveWorkspaces(mergedWorkspaces);
    storageService.saveNotes(mergedNotes);
    set({
      workspaces: mergedWorkspaces,
      notes: mergedNotes,
      activeWorkspaceId: newWorkspaces[0]?.id || get().activeWorkspaceId,
    });
  },

  setImportModalOpen: (open) => set({ importModalOpen: open }),
  setSettingsModalOpen: (open) => set({ settingsModalOpen: open }),
}));

storageService.onPulled((p) => {
  useWorkspaceStore.setState((st) => {
    const workspaces = p.workspaces ?? st.workspaces;
    return {
      workspaces,
      notes: p.notes ?? st.notes,
      layoutMode: p.layoutMode ?? st.layoutMode,
      activeWorkspaceId: workspaces.some((w) => w.id === st.activeWorkspaceId)
        ? st.activeWorkspaceId
        : workspaces[0]?.id ?? st.activeWorkspaceId,
    };
  });
});
storageService.init(initialWorkspaces, initialNotes);
