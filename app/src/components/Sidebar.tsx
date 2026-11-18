import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Pin, Globe, FileText, Plus, X, BookOpen, LayoutDashboard, Folder, FolderOpen, FolderPlus, ChevronRight, ChevronDown, Pencil, Trash2, FolderInput } from 'lucide-react';
import { useWorkspaceStore } from '../store/workspaceStore';
import { WorkspaceTab, TabFolder } from '../types/workspace';
import { HamburgerMenu } from './HamburgerMenu';
import { ConfirmDialog } from './ConfirmDialog';
import { setOverlay } from '../lib/overlay';

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

const TabRow = React.memo(({ tab, active, compact, lbl, indent, onFocus, onClose, onTogglePin, onMenu }: TabRowProps) => (
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
    className={`rail-item group flex items-center justify-between gap-2 py-1.5 rounded text-xs cursor-pointer ${indent ? 'pl-5 pr-2' : 'px-2'} ${
      active ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200'
    }`}
  >
    <div className="flex items-center gap-2 min-w-0">
      <TabIcon type={tab.type} />
      <span className={`truncate min-w-0 ${lbl}`}>{tab.title}</span>
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
));
TabRow.displayName = 'TabRow';

interface FolderHeaderProps {
  folder: TabFolder;
  count: number;
  lbl: string;
  editing: boolean;
  onToggle: (id: string) => void;
  onStartRename: (id: string | null) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onDropTab: (tabId: string, folderId: string) => void;
}

const FolderHeader = React.memo(({ folder, count, lbl, editing, onToggle, onStartRename, onRename, onDelete, onDropTab }: FolderHeaderProps) => {
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
      className={`group flex items-center gap-1.5 px-2 py-1.5 rounded text-xs cursor-pointer text-zinc-300 hover:bg-zinc-800/60 ${
        over ? 'bg-indigo-600/20 ring-1 ring-indigo-500/50' : ''
      }`}
    >
      {folder.collapsed ? <ChevronRight className="w-3 h-3 shrink-0 text-zinc-500" /> : <ChevronDown className="w-3 h-3 shrink-0 text-zinc-500" />}
      {folder.collapsed ? <Folder className="w-3.5 h-3.5 shrink-0 text-zinc-400" /> : <FolderOpen className="w-3.5 h-3.5 shrink-0 text-zinc-400" />}
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
        <span className={`flex items-center gap-1 opacity-0 group-hover:opacity-100 ${lbl ? 'hidden' : ''}`}>
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

export const Sidebar: React.FC = () => {
  // Granular selectors: a store change only re-renders the slices this component reads.
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const layoutMode = useWorkspaceStore((s) => s.layoutMode);
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
  // In compact-rail mode labels are always mounted but faded out, so expanding is a pure
  // clip-path/opacity change with no DOM or layout work.
  const compact = layoutMode === 'compact-rail';
  const lbl = compact ? 'transition-opacity duration-150 opacity-0 group-hover/rail:opacity-100' : '';

  const emitRail = (expanded: boolean) =>
    window.dispatchEvent(new CustomEvent('lifeapp:rail', { detail: { expanded, width: 256 } }));
  useEffect(() => {
    if (!compact) emitRail(false);
  }, [compact]);

  useEffect(() => {
    setOverlay('tabmenu', !!ctx);
    return () => setOverlay('tabmenu', false);
  }, [ctx]);

  const folders = useMemo(() => activeWs?.folders ?? [], [activeWs]);
  const { rootTabs, byFolder } = useMemo(() => {
    const ids = new Set(folders.map((f) => f.id));
    const map = new Map<string, WorkspaceTab[]>();
    const root: WorkspaceTab[] = [];
    for (const t of activeWs?.tabs ?? []) {
      if (t.folderId && ids.has(t.folderId)) {
        const arr = map.get(t.folderId) ?? [];
        arr.push(t);
        map.set(t.folderId, arr);
      } else root.push(t);
    }
    return { rootTabs: root, byFolder: map };
  }, [activeWs, folders]);

  const onFocus = useCallback((id: string) => focusTab(id), [focusTab]);
  const onClose = useCallback((id: string) => closeTab(id), [closeTab]);
  const onMenu = useCallback((tabId: string, x: number, y: number) => setCtx({ tabId, x, y }), []);
  const onDropTab = useCallback((tabId: string, folderId: string) => moveTabToFolder(tabId, folderId), [moveTabToFolder]);

  const newFolder = () => setEditingFolder(createFolder('New folder'));

  const renderRow = (tab: WorkspaceTab, indent: boolean) => (
    <TabRow
      key={tab.id}
      tab={tab}
      indent={indent}
      active={tab.id === activeWs?.primaryTabId || tab.id === activeWs?.secondaryTabId}
      compact={compact}
      lbl={lbl}
      onFocus={onFocus}
      onClose={onClose}
      onTogglePin={togglePin}
      onMenu={onMenu}
    />
  );

  const ctxTab = ctx ? activeWs?.tabs.find((t) => t.id === ctx.tabId) : undefined;
  const menuItem = 'w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left text-zinc-300 hover:bg-zinc-800';

  return (
    // Wrapper reserves 48px in compact mode; the 256px panel floats over the workspace on hover.
    <div className={compact ? 'relative w-12 shrink-0 h-full' : 'relative w-64 shrink-0 h-full'}>
      <aside
        onMouseEnter={compact ? () => emitRail(true) : undefined}
        onMouseLeave={compact ? () => emitRail(false) : undefined}
        className={`group/rail h-full w-64 bg-zinc-900 border-r border-zinc-800 flex flex-col select-none ${
          compact ? 'rail-collapsed absolute inset-y-0 left-0 z-30' : ''
        }`}
      >
        {/* Workspaces: only worth showing once there's more than one (imports add them). */}
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

        {/* Vertical tabs + folders */}
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
          {folders.map((f) => (
            <div key={f.id}>
              <FolderHeader
                folder={f}
                count={byFolder.get(f.id)?.length ?? 0}
                lbl={lbl}
                editing={editingFolder === f.id}
                onToggle={toggleFolder}
                onStartRename={setEditingFolder}
                onRename={renameFolder}
                onDelete={setFolderToDelete}
                onDropTab={onDropTab}
              />
              {!f.collapsed && byFolder.get(f.id)?.map((t) => renderRow(t, true))}
            </div>
          ))}
        </div>

        {/* Footer: single app menu */}
        <div className="p-2 border-t border-zinc-800 flex items-center">
          <HamburgerMenu placement="up" />
        </div>
      </aside>

      {ctx &&
        ctxTab &&
        createPortal(
          <>
            <div className="fixed inset-0 z-[60]" onMouseDown={() => setCtx(null)} onContextMenu={(e) => (e.preventDefault(), setCtx(null))} />
            <div
              style={{ left: Math.min(ctx.x, window.innerWidth - 200), top: Math.min(ctx.y, window.innerHeight - 260) }}
              className="fixed z-[61] w-48 py-1 bg-zinc-900 border border-zinc-800 rounded-lg shadow-xl shadow-black/50"
            >
              <button
                className={menuItem}
                onClick={() => {
                  togglePin(ctxTab.id);
                  setCtx(null);
                }}
              >
                <Pin className="w-3.5 h-3.5" /> {ctxTab.pinned ? 'Unpin tab' : 'Pin tab'}
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
                    setCtx(null);
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
                      setCtx(null);
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
                  setEditingFolder(id);
                  setCtx(null);
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
                      setCtx(null);
                    }}
                  >
                    <X className="w-3.5 h-3.5" /> Close tab
                  </button>
                </>
              )}
            </div>
          </>,
          document.body
        )}

      {folderToDelete && (
        <ConfirmDialog
          title="Delete folder?"
          body="The folder is removed. Its tabs stay open and move back to the main list."
          confirmLabel="Delete folder"
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
