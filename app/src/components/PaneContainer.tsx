import React, { Suspense, lazy } from 'react';
import { useWorkspaceStore } from '../store/workspaceStore';
import { WorkspaceTab } from '../types/workspace';
import { DashboardView } from './Dashboard/DashboardView';
import { jivvy, isElectron } from '../platform';

const NoteEditor = lazy(() => import('./NoteEditor').then((m) => ({ default: m.NoteEditor })));

/** Toggle mute for a tab's page (speaker indicator in the sidebar / top bar). Main owns the page. */
export function togglePaneMute(tabId: string) {
  jivvy?.setMuted(tabId, !useWorkspaceStore.getState().audioTabs[tabId]?.muted);
}

/** Electron: the page is a WebContentsView that main places over this exact rect. */
const ElectronPagePane: React.FC = () => (
  <div className="flex-1 flex flex-col h-full bg-zinc-950 min-w-0">
    <div data-page-slot className="flex-1 min-h-0 w-full bg-zinc-950" />
  </div>
);

const IframePane: React.FC<{ tab: WorkspaceTab }> = ({ tab }) => (
  <div className="flex-1 flex flex-col h-full bg-zinc-950 min-w-0">
    <iframe
      src={tab.url}
      title={tab.title}
      className="flex-1 w-full border-0 bg-white"
      sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
    />
  </div>
);

const SinglePane: React.FC<{ tab?: WorkspaceTab }> = ({ tab }) => {
  if (!tab) {
    return (
      <div className="flex-1 flex items-center justify-center text-zinc-500 text-sm">
        Open a tab, note, or import your Firefox bookmarks to begin.
      </div>
    );
  }
  if (tab.type === 'dashboard') {
    return (
      <div className="flex-1 flex flex-col h-full min-w-0 min-h-0 bg-zinc-950 overflow-auto">
        <DashboardView />
      </div>
    );
  }
  if (tab.type === 'note') {
    return (
      <div className="flex-1 flex flex-col h-full min-w-0 bg-zinc-950">
        <Suspense fallback={<div className="p-6 text-xs text-zinc-500">Loading editor…</div>}>
          <NoteEditor noteId={tab.noteId!} />
        </Suspense>
      </div>
    );
  }
  if (isElectron) return <ElectronPagePane />;
  return <IframePane tab={tab} />;
};

export const PaneContainer: React.FC = () => {
  const primaryTab = useWorkspaceStore((s) => {
    const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId);
    return ws?.tabs.find((t) => t.id === ws.primaryTabId);
  });
  const secondaryTab = useWorkspaceStore((s) => {
    const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId);
    return ws?.tabs.find((t) => t.id === ws.secondaryTabId);
  });
  const split = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId)?.layout === 'split-vertical');

  return (
    <div className="flex-1 flex h-full min-w-0 divide-x divide-zinc-800">
      <SinglePane tab={primaryTab} />
      {split && <SinglePane tab={secondaryTab} />}
    </div>
  );
};

