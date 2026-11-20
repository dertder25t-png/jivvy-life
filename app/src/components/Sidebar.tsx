import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Pin, Globe, FileText, Plus, X, BookOpen, LayoutDashboard, Folder, FolderOpen, FolderPlus, ChevronRight, ChevronDown, Pencil, Trash2, FolderInput, Columns2, EyeOff, Eye, Moon, Sun } from 'lucide-react';
import { useWorkspaceStore } from '../store/workspaceStore';
import { togglePaneMute } from './PaneContainer';
import { WorkspaceTab, TabFolder } from '../types/workspace';
import { HamburgerMenu } from './HamburgerMenu';
import { ConfirmDialog } from './ConfirmDialog';
import { setOverlay } from '../lib/overlay';
import { DownloadsButton } from './Downloads';
import { floatsToOverlay, isElectron, isOverlayRole, jivvy, nativeInvoke, openOverlay, portalTarget, viewport } from '../platform';
import { LAYOUT, EASE_CSS } from '../../shared/layout';

const DRAG_MIME = 'application/x-lifeapp-tab';

const TabIcon: React.FC<{ type: WorkspaceTab['type'] }> = ({ type }) =>
  type === 'dashboard' ? (
    <LayoutDashboard className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
  ) : type === 'jivvy' ? (
    <BookOpen className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
  ) : type === 'note' ? (
    <FileText className="w-3.5 h-3.5 text-amber-400 shrink-0" />
  ) : (
    <Globe className="w-3.5 h-3.5 text-sky-400 shrink-0" />
  );

const AudioBadge: React.FC<{ tabId: string }> = ({ tabId }) => {
  const a = useWorkspaceStore((s) => s.audioTabs[tabId]);
  if (!a?.playing) return null;
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        togglePaneMute(tabId);
      }}
      title={a.muted ? 'Unmute tab' : 'Mute tab'}
      aria-label={a.muted ? 'Unmute tab' : 'Mute tab'}
      className="shrink-0 text-xs leading-none hover:opacity-80"
    >
      {a.muted ? '🔇' : '🔊'}
    </button>
  );
};

/** Electron memory saver: this tab's page is unloaded until it is opened again. */
export const useSleeping = (tabId: string) => useWorkspaceStore((s) => !!s.runtime.tabs[tabId]?.sleeping);
export const SleepBadge: React.FC<{ tabId: string }> = ({ tabId }) =>
  useSleeping(tabId) ? <Moon aria-label="Sleeping tab" className="w-3 h-3 shrink-0 text-indigo-300/80"><title>Sleeping to save memory</title></Moon> : null;

interface TabRowProps {
  tab: WorkspaceTab;
  active: boolean;
  compact: boolean;
  lbl: string;
  indent: boolean;
  onFocus: (id: string) => void;
  onClose: (id: string) => void;
  onTogglePin: (id: string) => void;
  onMenu: (id: string, x: number, y: number) => void;
}

const TabRow = React.memo(({ tab, active, compact, lbl, indent, onFocus, onClose, onTogglePin, onMenu }: TabRowProps) => {
  const sleeping = useSleeping(tab.id);
  return (
  <div
    draggable
    onDragStart={(e) => {
      e.dataTransfer.setData(DRAG_MIME, tab.id);
      e.dataTransfer.effectAllowed = 'move';
    }}
    onClick={() => onFocus(tab.id)}
    onContextMenu={(e) => {
      e.preventDefault();
      onMenu(tab.id, e.clientX, e.clientY);
    }}
    className={`rail-item group flex items-center justify-between gap-2 py-1.5 rounded text-xs cursor-pointer ${indent ? 'pl-5 pr-2' : 'px-2'} ${sleeping ? 'opacity-60' : ''} ${
      active ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200'
    }`}
  >
    <div className="flex items-center gap-2 min-w-0">
      <TabIcon type={tab.type} />
      <span className={`truncate min-w-0 ${lbl}`}>{tab.title}</span>
      <SleepBadge tabId={tab.id} />
      <AudioBadge tabId={tab.id} />
    </div>
    <div className={`flex items-center gap-1 shrink-0 ${compact ? lbl : ''}`}>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onTogglePin(tab.id);
        }}
        title={tab.pinned ? 'Unpin tab' : 'Pin tab'}
        className={tab.pinned ? 'text-indigo-400' : 'opacity-0 group-hover:opacity-100 text-zinc-500 hover:text-indigo-300'}
      >
        <Pin className="w-3.5 h-3.5" />
      </button>
      {tab.type !== 'dashboard' && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onClose(tab.id);
          }}
          title="Close tab"
          aria-label="Close tab"
          className="p-0.5 rounded text-zinc-600 group-hover:text-zinc-400 hover:!text-red-400 hover:bg-zinc-700/60"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  </div>
  );
});
TabRow.displayName = 'TabRow';

interface FolderHeaderProps {
  folder: TabFolder;
  count: number;
  compact: boolean;
  lbl: string;
  editing: boolean;
  onToggle: (id: string) => void;
  onStartRename: (id: string | null) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onDropTab: (tabId: string, folderId: string) => void;
}

const FolderHeader = React.memo(({ folder, count, compact, lbl, editing, onToggle, onStartRename, onRename, onDelete, onDropTab }: FolderHeaderProps) => {
  const [over, setOver] = useState(false);
  const [name, setName] = useState(folder.name);
  useEffect(() => setName(folder.name), [folder.name, editing]);
  const commit = () => {
    onRename(folder.id, name);
    onStartRename(null);
  };
  return (
    <div
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(DRAG_MIME)) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const id = e.dataTransfer.getData(DRAG_MIME);
        if (id) onDropTab(id, folder.id);
      }}
      onClick={() => !editing && onToggle(folder.id)}
      onDoubleClick={() => onStartRename(folder.id)}
      title={folder.name}
      className={`rail-item group flex items-center gap-1.5 px-2 py-1.5 rounded text-xs cursor-pointer text-zinc-300 hover:bg-zinc-800/60 ${
        over ? 'bg-indigo-600/20 ring-1 ring-indigo-500/50' : ''
      }`}
    >
      {folder.collapsed ? (
        <Folder className="w-3.5 h-3.5 shrink-0 text-zinc-400" />
      ) : (
        <FolderOpen className="w-3.5 h-3.5 shrink-0 text-zinc-400" />
      )}
      <span className={compact ? 'hidden group-hover/rail:inline-flex shrink-0' : 'inline-flex shrink-0'}>
        {folder.collapsed ? (
          <ChevronRight className="w-3 h-3 text-zinc-500" />
        ) : (
          <ChevronDown className="w-3 h-3 text-zinc-500" />
        )}
      </span>
      {editing ? (
        <input
          autoFocus
          value={name}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setName(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            else if (e.key === 'Escape') onStartRename(null);
          }}
          className="flex-1 min-w-0 bg-zinc-950 border border-indigo-500 rounded px-1 py-0.5 text-xs text-zinc-100 focus:outline-none"
        />
      ) : (
        <span className={`truncate flex-1 ${lbl}`}>
          {folder.name} <span className="text-zinc-600">{count}</span>
        </span>
      )}
      {!editing && (
        <span className={`flex items-center gap-1 opacity-0 group-hover:opacity-100 ${compact ? 'hidden group-hover/rail:flex' : ''}`}>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onStartRename(folder.id);
            }}
            title="Rename folder"
            className="text-zinc-500 hover:text-zinc-200"
          >
            <Pencil className="w-3 h-3" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete(folder.id);
            }}
            title="Delete folder"
            className="text-zinc-500 hover:text-red-400"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </span>
      )}
    </div>
  );
});
FolderHeader.displayName = 'FolderHeader';

interface CtxMenu {
  tabId: string;
  x: number;
  y: number;
}

const menuItem = 'w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left text-zinc-300 hover:bg-zinc-800';

/** Right-click menu for a tab. Inline (inside an overlay surface) or the overlay's popup. */
export const TabContextMenu: React.FC<{
  tabId: string;
  x: number;
  y: number;
  onClose: () => void;
  onEditFolder: (id: string) => void;
}> = ({ tabId, x, y, onClose, onEditFolder }) => {
  const ctxTab = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId)?.tabs.find((t) => t.id === tabId));
  const showFolders = useWorkspaceStore((s) => s.showFolders);
  const allFolders = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId)?.folders);
  const folders = showFolders ? allFolders ?? [] : [];
  const { togglePin, focusTab, moveTabToFolder, createFolder, closeTab } = useWorkspaceStore.getState();
  const sleeping = useSleeping(tabId);
  if (!ctxTab) return null;
  const vp = viewport();
  return (
    <div
      style={{ left: Math.min(x, vp.width - 200), top: Math.min(y, vp.height - 280) }}
      className="fixed z-[61] w-48 py-1 bg-zinc-900 border border-zinc-800 rounded-lg shadow-xl shadow-black/50"
    >
      <button
        className={menuItem}
        onClick={() => {
          togglePin(ctxTab.id);
          onClose();
        }}
      >
        <Pin className="w-3.5 h-3.5" /> {ctxTab.pinned ? 'Unpin tab' : 'Pin tab'}
      </button>
      {isElectron && ctxTab.type !== 'dashboard' && ctxTab.type !== 'note' && (
        <button
          className={menuItem}
          onClick={() => {
            void nativeInvoke(sleeping ? 'wake_tab' : 'sleep_tab', { tabId: ctxTab.id }).catch(() => {});
            onClose();
          }}
        >
          {sleeping ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />} {sleeping ? 'Wake tab' : 'Sleep tab'}
        </button>
      )}
      <button
        className={menuItem}
        onClick={() => {
          focusTab(ctxTab.id, 'secondary');
          onClose();
        }}
      >
        <Columns2 className="w-3.5 h-3.5" /> Open in split pane
      </button>
      <div className="my-1 border-t border-zinc-800" />
      <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-zinc-500 flex items-center gap-1.5">
        <FolderInput className="w-3 h-3" /> Move to folder
      </div>
      {ctxTab.folderId && (
        <button
          className={menuItem}
          onClick={() => {
            moveTabToFolder(ctxTab.id, null);
            onClose();
          }}
        >
          No folder
        </button>
      )}
      {folders
        .filter((f) => f.id !== ctxTab.folderId)
        .map((f) => (
          <button
            key={f.id}
            className={menuItem}
            onClick={() => {
              moveTabToFolder(ctxTab.id, f.id);
              onClose();
            }}
          >
            <Folder className="w-3.5 h-3.5 text-zinc-500" /> <span className="truncate">{f.name}</span>
          </button>
        ))}
      <button
        className={menuItem}
        onClick={() => {
          const id = createFolder('New folder');
          moveTabToFolder(ctxTab.id, id);
          onEditFolder(id);
          onClose();
        }}
      >
        <FolderPlus className="w-3.5 h-3.5 text-zinc-500" /> New folder…
      </button>
      {ctxTab.type !== 'dashboard' && (
        <>
          <div className="my-1 border-t border-zinc-800" />
          <button
            className={`${menuItem} !text-red-400`}
            onClick={() => {
              closeTab(ctxTab.id);
              onClose();
            }}
          >
            <X className="w-3.5 h-3.5" /> Close tab
          </button>
        </>
      )}
    </div>
  );
};

const FOLDER_DELETE = {
  title: 'Delete folder?',
  body: 'The folder is removed. Its tabs stay open and move back to the main list.',
  confirmLabel: 'Delete folder',
};

/**
 * The tab sidebar. `floating` is the Electron overlay copy: the compact rail / Zen rail expanded
 * over the page (the base view keeps the collapsed rail underneath).
 */
export const Sidebar: React.FC<{ floating?: boolean; onLeave?: () => void; onEnter?: () => void }> = ({ floating = false, onLeave, onEnter }) => {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const layoutMode = useWorkspaceStore((s) => s.layoutMode);
  const showFolders = useWorkspaceStore((s) => s.showFolders);
  const setShowFolders = useWorkspaceStore((s) => s.setShowFolders);
  const focusTab = useWorkspaceStore((s) => s.focusTab);
  const closeTab = useWorkspaceStore((s) => s.closeTab);
  const togglePin = useWorkspaceStore((s) => s.togglePin);
  const createNote = useWorkspaceStore((s) => s.createNote);
  const createFolder = useWorkspaceStore((s) => s.createFolder);
  const renameFolder = useWorkspaceStore((s) => s.renameFolder);
  const deleteFolder = useWorkspaceStore((s) => s.deleteFolder);
  const toggleFolder = useWorkspaceStore((s) => s.toggleFolder);
  const moveTabToFolder = useWorkspaceStore((s) => s.moveTabToFolder);

  const [editingFolder, setEditingFolder] = useState<string | null>(null);
  const [ctx, setCtx] = useState<CtxMenu | null>(null);
  const [folderToDelete, setFolderToDelete] = useState<string | null>(null);
  const [rootOver, setRootOver] = useState(false);

  const activeWs = workspaces.find((w) => w.id === activeWorkspaceId) || workspaces[0];
  const isZenLeft = layoutMode === 'zen';
  // The floating overlay copy is always the expanded rail: full rows, labels visible.
  const compact = !floating && (layoutMode === 'compact-rail' || isZenLeft);
  const lbl = compact ? 'transition-opacity duration-150 opacity-0 group-hover/rail:opacity-100' : '';

  const wrapperRef = useRef<HTMLDivElement>(null);
  const emitRail = useCallback(
    (expanded: boolean) =>
      window.dispatchEvent(new CustomEvent('lifeapp:rail', { detail: { expanded, width: LAYOUT.SIDEBAR_W } })),
    []
  );
  const railTimer = useRef<number | null>(null);
  const railIntent = useCallback(
    (expanded: boolean) => {
      if (railTimer.current !== null) window.clearTimeout(railTimer.current);
      railTimer.current = null;
      if (floatsToOverlay) {
        // Electron: after a short hover, the expanded rail floats over the page in the overlay view.
        if (!expanded) return;
        railTimer.current = window.setTimeout(() => {
          const r = wrapperRef.current?.getBoundingClientRect();
          if (r) openOverlay({ kind: 'rail', anchor: { x: r.left, y: r.top, width: r.width, height: r.height } });
        }, LAYOUT.RAIL_OPEN_MS);
        return;
      }
      railTimer.current = window.setTimeout(() => emitRail(expanded), expanded ? 180 : 250);
    },
    [emitRail]
  );
  useEffect(() => () => { if (railTimer.current !== null) window.clearTimeout(railTimer.current); }, []);

  // Always reset rail state when mode changes OR when Sidebar unmounts (prevents Compact -> Zen 256px stuck bug)
  useEffect(() => {
    if (isElectron) return;
    if (railTimer.current !== null) window.clearTimeout(railTimer.current);
    if (!compact) emitRail(false);
    return () => { emitRail(false); };
  }, [compact, emitRail]);

  useEffect(() => {
    setOverlay('tabmenu', !!ctx);
    return () => { setOverlay('tabmenu', false); };
  }, [ctx]);

  // "New folder…" picked in the overlay's tab menu: start renaming it here.
  useEffect(() => {
    if (!isElectron) return;
    const onUi = (e: Event) => {
      const ev = (e as CustomEvent<{ type: string; id?: string }>).detail;
      if (ev?.type === 'edit-folder' && ev.id) setEditingFolder(ev.id);
    };
    window.addEventListener('jivvy:ui', onUi);
    return () => window.removeEventListener('jivvy:ui', onUi);
  }, []);

  const folders = useMemo(() => (showFolders ? activeWs?.folders ?? [] : []), [activeWs, showFolders]);
  const { rootTabs, byFolder } = useMemo(() => {
    const ids = new Set(folders.map((f) => f.id));
    const map = new Map<string, WorkspaceTab[]>();
    const root: WorkspaceTab[] = [];
    const sortedTabs = [
      ...(activeWs?.tabs.filter((t) => t.pinned) ?? []),
      ...(activeWs?.tabs.filter((t) => !t.pinned) ?? []),
    ];
    for (const t of sortedTabs) {
      if (showFolders && t.folderId && ids.has(t.folderId)) {
        const arr = map.get(t.folderId) ?? [];
        arr.push(t);
        map.set(t.folderId, arr);
      } else root.push(t);
    }
    return { rootTabs: root, byFolder: map };
  }, [activeWs, folders, showFolders]);

  const onFocus = useCallback((id: string) => focusTab(id), [focusTab]);
  const onClose = useCallback((id: string) => closeTab(id), [closeTab]);
  const onMenu = useCallback((tabId: string, x: number, y: number) => {
    if (floatsToOverlay) openOverlay({ kind: 'tabmenu', tabId, x, y });
    else setCtx({ tabId, x, y });
  }, []);
  const onDropTab = useCallback((tabId: string, folderId: string) => moveTabToFolder(tabId, folderId), [moveTabToFolder]);
  const askDeleteFolder = useCallback((id: string) => {
    if (isElectron) openOverlay({ kind: 'confirm', ...FOLDER_DELETE, action: { type: 'deleteFolder', folderId: id } });
    else setFolderToDelete(id);
  }, []);
  const editFolder = useCallback((id: string) => {
    if (isOverlayRole) jivvy?.emit({ type: 'edit-folder', id });
    setEditingFolder(id);
  }, []);

  const newFolder = () => {
    if (!showFolders) setShowFolders(true);
    setEditingFolder(createFolder('New folder'));
  };

  const renderRow = (tab: WorkspaceTab, indent: boolean) => (
    <TabRow
      key={tab.id}
      tab={tab}
      indent={indent && (!compact)}
      active={tab.id === activeWs?.primaryTabId || tab.id === activeWs?.secondaryTabId}
      compact={compact}
      lbl={lbl}
      onFocus={onFocus}
      onClose={onClose}
      onTogglePin={togglePin}
      onMenu={onMenu}
    />
  );

  // Electron base view: the collapsed rail never expands in place (the page sits right next to
  // it); hovering it opens the floating copy in the overlay view instead.
  const railClass = floatsToOverlay ? 'rail-static' : 'rail-collapsed';
  const wrapperClass = floating
    ? 'relative h-full'
    : isZenLeft
    ? `${floatsToOverlay ? '' : 'rail-zen-wrap '}relative w-1.5 shrink-0 h-full bg-zinc-950 hover:bg-indigo-500/30 transition-colors`
    : compact
    ? 'relative w-12 shrink-0 h-full'
    : 'relative w-64 shrink-0 h-full';

  const asideClass = floating
    ? `rail-float ${isZenLeft ? 'rail-float-zen' : ''}`
    : isZenLeft
    ? `${floatsToOverlay ? 'rail-static-zen' : 'rail-zen'} absolute inset-y-0 left-0 z-30`
    : compact
    ? `${railClass} absolute inset-y-0 left-0 z-30`
    : '';

  // Electron: the sidebar edge animates between pinned and rail widths; main moves the page in step.
  const wrapperStyle: React.CSSProperties | undefined =
    isElectron && !floating ? { transition: `width ${LAYOUT.ANIM_MS}ms ${EASE_CSS}` } : undefined;

  return (
    <div
      ref={wrapperRef}
      className={wrapperClass}
      style={wrapperStyle}
      onMouseEnter={floating ? onEnter : compact ? () => railIntent(true) : undefined}
      onMouseLeave={floating ? onLeave : compact ? () => railIntent(false) : undefined}
    >
      <aside className={`group/rail h-full w-64 bg-zinc-900 border-r border-zinc-800 flex flex-col select-none ${asideClass}`}>
        {workspaces.length > 1 && (
          <div className="p-2 border-b border-zinc-800 space-y-1">
            <div className={`text-[10px] uppercase tracking-wider text-zinc-500 px-2 ${lbl}`}>Workspaces</div>
            {workspaces.map((ws) => (
              <button
                key={ws.id}
                onClick={() => setActiveWorkspace(ws.id)}
                title={ws.name}
                className={`rail-item w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs ${
                  ws.id === activeWorkspaceId ? 'bg-indigo-600/20 text-indigo-300 font-medium' : 'text-zinc-400 hover:bg-zinc-800'
                }`}
              >
                <span className="w-5 shrink-0 text-center font-semibold">{ws.name.slice(0, 2).toUpperCase()}</span>
                <span className={`truncate ${lbl}`}>{ws.name}</span>
              </button>
            ))}
          </div>
        )}

        <div
          className={`flex-1 overflow-y-auto p-2 space-y-0.5 ${rootOver ? 'bg-zinc-800/30' : ''}`}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes(DRAG_MIME)) {
              e.preventDefault();
              setRootOver(true);
            }
          }}
          onDragLeave={(e) => e.currentTarget === e.target && setRootOver(false)}
          onDrop={(e) => {
            setRootOver(false);
            const id = e.dataTransfer.getData(DRAG_MIME);
            if (id) {
              e.preventDefault();
              moveTabToFolder(id, null);
            }
          }}
        >
          <div className={`flex items-center justify-between px-2 mb-1 ${lbl}`}>
            <span className="text-[10px] uppercase tracking-wider text-zinc-500">Tabs</span>
            <span className="flex items-center gap-2">
              <button
                onClick={() => setShowFolders(!showFolders)}
                title={showFolders ? 'Hide folders' : 'Show folders'}
                className="text-zinc-400 hover:text-white"
              >
                {showFolders ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
              </button>
              <button onClick={newFolder} title="New folder" className="text-zinc-400 hover:text-white">
                <FolderPlus className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => createNote(`Note ${new Date().toLocaleTimeString()}`)}
                title="New Markdown Note"
                className="text-zinc-400 hover:text-white"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            </span>
          </div>
          {rootTabs.map((t) => renderRow(t, false))}
          {showFolders &&
            folders.map((f) => (
              <div key={f.id}>
                <FolderHeader
                  folder={f}
                  count={byFolder.get(f.id)?.length ?? 0}
                  compact={compact}
                  lbl={lbl}
                  editing={editingFolder === f.id}
                  onToggle={toggleFolder}
                  onStartRename={setEditingFolder}
                  onRename={renameFolder}
                  onDelete={askDeleteFolder}
                  onDropTab={onDropTab}
                />
                {!f.collapsed && byFolder.get(f.id)?.map((t) => renderRow(t, true))}
              </div>
            ))}
        </div>

        <div className={`p-2 border-t border-zinc-800 flex gap-1 ${compact ? 'flex-col' : 'items-center'}`}>
          <DownloadsButton className="p-1.5" />
          <HamburgerMenu placement="up" />
        </div>
      </aside>

      {ctx &&
        createPortal(
          <>
            <div className="fixed inset-0 z-[60]" onMouseDown={() => setCtx(null)} onContextMenu={(e) => (e.preventDefault(), setCtx(null))} />
            <TabContextMenu tabId={ctx.tabId} x={ctx.x} y={ctx.y} onClose={() => setCtx(null)} onEditFolder={editFolder} />
          </>,
          portalTarget()
        )}

      {folderToDelete && (
        <ConfirmDialog
          title={FOLDER_DELETE.title}
          body={FOLDER_DELETE.body}
          confirmLabel={FOLDER_DELETE.confirmLabel}
          onCancel={() => setFolderToDelete(null)}
          onConfirm={() => {
            deleteFolder(folderToDelete);
            setFolderToDelete(null);
          }}
        />
      )}
    </div>
  );
};
