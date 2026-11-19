import React, { Suspense, lazy, useEffect, useState } from 'react';
import { useWorkspaceStore } from './store/workspaceStore';
import { Sidebar } from './components/Sidebar';
import { PaneContainer } from './components/PaneContainer';
import { TopTabBar } from './components/TopTabBar';
import { ZenOmnibox } from './components/ZenOmnibox';
import { AddressBar } from './components/AddressBar';
import { useHoverIntent } from './lib/useHoverIntent';

const ImportWizard = lazy(() => import('./components/ImportWizard').then((m) => ({ default: m.ImportWizard })));
const SettingsModal = lazy(() => import('./components/SettingsModal').then((m) => ({ default: m.SettingsModal })));

function hostOf(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return 'web';
  }
}

const ZenHorizontalBar: React.FC<{ position: 'top' | 'bottom' }> = ({ position }) => {
  const { active: hovered, onEnter, onLeave } = useHoverIntent(150, 400);

  return (
    <div
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      className="shrink-0"
    >
      {!hovered ? (
        <div
          className={`h-1.5 w-full bg-zinc-950 hover:bg-indigo-500/30 transition-colors ${
            position === 'top' ? 'border-b border-zinc-900' : 'border-t border-zinc-900'
          }`}
          title="Hover to reveal Zen tabs & address bar"
        />
      ) : (
        <div className="bg-zinc-900 shadow-xl">
          <TopTabBar />
          <AddressBar />
        </div>
      )}
    </div>
  );
};

export default function App() {
  const layoutMode = useWorkspaceStore((s) => s.layoutMode);
  const showTopBar = useWorkspaceStore((s) => s.showTopBar);
  const zenBarPosition = useWorkspaceStore((s) => s.zenBarPosition);
  const importModalOpen = useWorkspaceStore((s) => s.importModalOpen);
  const settingsModalOpen = useWorkspaceStore((s) => s.settingsModalOpen);

  const isZen = layoutMode === 'zen';
  const showSidebar =
    layoutMode === 'left-vertical' ||
    layoutMode === 'compact-rail' ||
    (isZen && zenBarPosition === 'left');

  useEffect(() => {
    const onOpen = (e: Event) => {
      const url = (e as CustomEvent<{ url?: string }>).detail?.url;
      if (!url) return;
      useWorkspaceStore.getState().openTab({ title: hostOf(url), type: 'web', url });
    };
    window.addEventListener('lifeapp:open-url', onOpen);
    return () => window.removeEventListener('lifeapp:open-url', onOpen);
  }, []);

  return (
    <div className="h-screen w-screen flex flex-col bg-zinc-950 text-zinc-100 overflow-hidden">
      {!isZen && showTopBar && (
        <header data-tauri-drag-region className="h-8 bg-zinc-900 border-b border-zinc-800 shrink-0" />
      )}

      {layoutMode === 'classic-top' && <TopTabBar />}
      {isZen && zenBarPosition === 'top' && <ZenHorizontalBar position="top" />}

      <div className="flex-1 flex min-h-0">
        {showSidebar && <Sidebar />}
        <div className="flex-1 flex flex-col min-w-0 min-h-0">
          {(!isZen || zenBarPosition === 'left') && <AddressBar />}
          <PaneContainer />
          {isZen && zenBarPosition === 'bottom' && <ZenHorizontalBar position="bottom" />}
        </div>
      </div>

      <ZenOmnibox />
      <Suspense fallback={null}>
        {importModalOpen && <ImportWizard />}
        {settingsModalOpen && <SettingsModal />}
      </Suspense>
    </div>
  );
}
