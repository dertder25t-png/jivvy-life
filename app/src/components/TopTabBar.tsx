import React, { useCallback, useMemo } from 'react';
import { Globe, FileText, BookOpen, X, Plus, Pin, LayoutDashboard } from 'lucide-react';
import { useWorkspaceStore } from '../store/workspaceStore';
import { togglePaneMute } from './PaneContainer';
import { WorkspaceTab } from '../types/workspace';
import { OPEN_OMNIBOX_EVENT } from './ZenOmnibox';
import { HamburgerMenu } from './HamburgerMenu';
import { isElectron, openOverlay } from '../platform';

export const NAV_EVENT = 'lifeapp:nav';

const TabIcon: React.FC<{ type: WorkspaceTab['type'] }> = ({ type }) => {
  if (type === 'dashboard') return <LayoutDashboard className="w-3.5 h-3.5 text-indigo-400 shrink-0" />;
  if (type === 'jivvy') return <BookOpen className="w-3.5 h-3.5 text-emerald-400 shrink-0" />;
  if (type === 'note') return <FileText className="w-3.5 h-3.5 text-amber-400 shrink-0" />;
  return <Globe className="w-3.5 h-3.5 text-sky-400 shrink-0" />;
};

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

interface TabChipProps {
  tab: WorkspaceTab;
  active: boolean;
  onFocus: (id: string) => void;
  onClose: (id: string) => void;
  onTogglePin: (id: string) => void;
}

const TabChip = React.memo(({ tab, active, onFocus, onClose, onTogglePin }: TabChipProps) => (
  <div
    role="tab"
    aria-selected={active}
    onClick={() => onFocus(tab.id)}
    onContextMenu={(e) => {
      e.preventDefault();
      onTogglePin(tab.id);
    }}
    title={tab.pinned ? 'Right-click to unpin' : 'Right-click to pin'}
    className={`group relative flex items-center gap-2 h-8 max-w-[220px] min-w-[120px] pl-3 pr-1.5 rounded-t-md text-xs cursor-pointer transition-colors duration-150 ${
      active
        ? 'bg-zinc-800 text-zinc-100'
        : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200'
    }`}
  >
    {active && <span className="absolute left-0 right-0 top-0 h-0.5 rounded bg-indigo-500" />}
    {tab.pinned && <Pin className="w-3 h-3 text-zinc-500 shrink-0 -rotate-45" />}
    <TabIcon type={tab.type} />
    <span className="truncate flex-1">{tab.title}</span>
    <AudioBadge tabId={tab.id} />
    {tab.type !== 'dashboard' && (
      <button
        onClick={(e) => {
          e.stopPropagation();
          onClose(tab.id);
        }}
        title="Close tab"
        className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-zinc-700 hover:text-red-400 transition-opacity"
      >
        <X className="w-3 h-3" />
      </button>
    )}
  </div>
));
TabChip.displayName = 'TabChip';

export const TopTabBar: React.FC = () => {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const focusTab = useWorkspaceStore((s) => s.focusTab);
  const closeTab = useWorkspaceStore((s) => s.closeTab);
  const togglePin = useWorkspaceStore((s) => s.togglePin);

  const ws = useMemo(
    () => workspaces.find((w) => w.id === activeWorkspaceId) ?? workspaces[0],
    [workspaces, activeWorkspaceId]
  );

  const tabs = useMemo(() => {
    if (!ws) return [];
    return [...ws.tabs.filter((t) => t.pinned), ...ws.tabs.filter((t) => !t.pinned)];
  }, [ws]);

  const activeId = ws?.primaryTabId ?? null;

  const handleFocus = useCallback((id: string) => focusTab(id), [focusTab]);
  const handleClose = useCallback((id: string) => closeTab(id), [closeTab]);

  return (
    <div className="h-10 shrink-0 flex items-end gap-1 bg-zinc-900 border-b border-zinc-800 px-2">
      <HamburgerMenu placement="down" className="self-center mb-0.5" />

      <div role="tablist" className="flex-1 min-w-0 flex items-end gap-1 overflow-x-auto no-scrollbar">
        {tabs.map((tab) => (
          <TabChip key={tab.id} tab={tab} active={tab.id === activeId} onFocus={handleFocus} onClose={handleClose} onTogglePin={togglePin} />
        ))}
      </div>

      <button
        onClick={() => (isElectron ? openOverlay({ kind: 'omnibox' }) : window.dispatchEvent(new Event(OPEN_OMNIBOX_EVENT)))}
        title="New tab (Cmd/Ctrl+K)"
        className="self-center p-1.5 mb-0.5 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors shrink-0"
      >
        <Plus className="w-4 h-4" />
      </button>
    </div>
  );
};
