import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Menu,
  PanelLeft,
  PanelLeftClose,
  PanelTop,
  Maximize2,
  Upload,
  RefreshCw,
  Settings,
  Columns2,
  Trash2,
  Check,
} from 'lucide-react';
import { useWorkspaceStore } from '../store/workspaceStore';
import { LayoutMode } from '../types/workspace';
import { setOverlay } from '../lib/overlay';
import { ConfirmDialog } from './ConfirmDialog';

const MODES: Array<{ id: LayoutMode; label: string; icon: React.ReactNode }> = [
  { id: 'left-vertical', label: 'Left Tabs', icon: <PanelLeft className="w-4 h-4" /> },
  { id: 'compact-rail', label: 'Compact', icon: <PanelLeftClose className="w-4 h-4" /> },
  { id: 'classic-top', label: 'Top Bar', icon: <PanelTop className="w-4 h-4" /> },
  { id: 'zen', label: 'Zen', icon: <Maximize2 className="w-4 h-4" /> },
];

const Item: React.FC<{ icon: React.ReactNode; label: string; onClick: () => void; active?: boolean; danger?: boolean }> = ({
  icon,
  label,
  onClick,
  active,
  danger,
}) => (
  <button
    onClick={onClick}
    className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-left hover:bg-zinc-800 ${
      danger ? 'text-red-400' : active ? 'text-indigo-300' : 'text-zinc-300'
    }`}
  >
    <span className="shrink-0">{icon}</span>
    <span className="flex-1">{label}</span>
    {active && <Check className="w-3.5 h-3.5" />}
  </button>
);

const Divider = () => <div className="my-1 border-t border-zinc-800" />;

/** Single app menu: layout, import/sync, settings, clear tabs. Popover is portaled so sidebar clipping can't cut it. */
export const HamburgerMenu: React.FC<{ placement?: 'up' | 'down'; className?: string }> = React.memo(
  ({ placement = 'up', className = '' }) => {
    const layoutMode = useWorkspaceStore((s) => s.layoutMode);
    const setLayoutMode = useWorkspaceStore((s) => s.setLayoutMode);
    const setImportModalOpen = useWorkspaceStore((s) => s.setImportModalOpen);
    const setSettingsModalOpen = useWorkspaceStore((s) => s.setSettingsModalOpen);
    const toggleSplitPane = useWorkspaceStore((s) => s.toggleSplitPane);
    const clearAllTabs = useWorkspaceStore((s) => s.clearAllTabs);

    const btnRef = useRef<HTMLButtonElement>(null);
    const [open, setOpen] = useState(false);
    const [confirm, setConfirm] = useState(false);
    const [pos, setPos] = useState({ left: 0, top: 0, bottom: 0 });

    const close = useCallback(() => setOpen(false), []);

    useEffect(() => {
      setOverlay('hamburger', open);
      if (!open) return;
      const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [open, close]);
    useEffect(() => () => setOverlay('hamburger', false), []);

    const toggle = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (r) setPos({ left: r.left, top: r.bottom + 4, bottom: window.innerHeight - r.top + 4 });
      setOpen((o) => !o);
    };
    const run = (fn: () => void) => () => {
      close();
      fn();
    };

    return (
      <>
        <button
          ref={btnRef}
          onClick={toggle}
          title="Menu"
          aria-haspopup="menu"
          aria-expanded={open}
          className={`p-1.5 rounded text-zinc-400 hover:text-white hover:bg-zinc-800 ${open ? 'bg-zinc-800 text-white' : ''} ${className}`}
        >
          <Menu className="w-4 h-4" />
        </button>

        {open &&
          createPortal(
            <>
              <div className="fixed inset-0 z-[60]" onMouseDown={close} onContextMenu={(e) => (e.preventDefault(), close())} />
              <div
                role="menu"
                style={placement === 'up' ? { left: pos.left, bottom: pos.bottom } : { left: pos.left, top: pos.top }}
                className="fixed z-[61] w-52 py-1 bg-zinc-900 border border-zinc-800 rounded-lg shadow-xl shadow-black/50"
              >
                <div className="px-3 pt-1 pb-1 text-[10px] uppercase tracking-wider text-zinc-500">Layout</div>
                {MODES.map((m) => (
                  <Item
                    key={m.id}
                    icon={m.icon}
                    label={m.label}
                    active={layoutMode === m.id}
                    onClick={run(() => setLayoutMode(m.id))}
                  />
                ))}
                <Divider />
                <Item icon={<Columns2 className="w-4 h-4" />} label="Toggle split pane" onClick={run(toggleSplitPane)} />
                <Item icon={<Upload className="w-4 h-4" />} label="Import" onClick={run(() => setImportModalOpen(true))} />
                <Item icon={<RefreshCw className="w-4 h-4" />} label="Sync" onClick={run(() => setSettingsModalOpen(true))} />
                <Item icon={<Settings className="w-4 h-4" />} label="Settings" onClick={run(() => setSettingsModalOpen(true))} />
                <Divider />
                <Item icon={<Trash2 className="w-4 h-4" />} label="Clear all tabs" danger onClick={run(() => setConfirm(true))} />
              </div>
            </>,
            document.body
          )}

        {confirm && (
          <ConfirmDialog
            title="Clear all tabs?"
            body="This closes every tab in this workspace except pinned tabs and the Dashboard."
            confirmLabel="Clear tabs"
            onCancel={() => setConfirm(false)}
            onConfirm={() => {
              setConfirm(false);
              clearAllTabs();
            }}
          />
        )}
      </>
    );
  }
);
HamburgerMenu.displayName = 'HamburgerMenu';
