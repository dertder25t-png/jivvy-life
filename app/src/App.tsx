import React, { Suspense, lazy, useEffect, useState } from 'react';
import { useWorkspaceStore } from './store/workspaceStore';
import { Sidebar } from './components/Sidebar';
import { PaneContainer } from './components/PaneContainer';
import { TopTabBar } from './components/TopTabBar';
import { ZenOmnibox } from './components/ZenOmnibox';
import { AddressBar } from './components/AddressBar';
import { useHoverIntent } from './lib/useHoverIntent';
import { floatsToOverlay, isElectron, openOverlay } from './platform';
import { LAYOUT } from '../shared/layout';

const ImportWizard = lazy(() => import('./components/ImportWizard').then((m) => ({ default: m.ImportWizard })));
const SettingsModal = lazy(() => import('./components/SettingsModal').then((m) => ({ default: m.SettingsModal })));

function hostOf(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return 'web';
  }
}

/** Zen top/bottom edge: hover the strip to reveal the tab strip + address bar. */
export const ZenBarContent: React.FC = () => (
  <div className="bg-zinc-900 shadow-xl">
    <TopTabBar />
    <AddressBar floating={isElectron} />
  </div>
);

const ZenHorizontalBar: React.FC<{ position: 'top' | 'bottom' }> = ({ position }) => {
  const { active: hovered, onEnter: hoverEnter, onLeave: hoverLeave } = useHoverIntent(150, 400);
  // Electron: the revealed bar floats over the page in the overlay view; the page never moves.
  const stripRef = React.useRef<HTMLDivElement>(null);
  const timer = React.useRef(0);
  React.useEffect(() => () => window.clearTimeout(timer.current), []);
  const onEnter = () => {
    if (!floatsToOverlay) return hoverEnter();
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const r = stripRef.current?.getBoundingClientRect();
      if (r) openOverlay({ kind: 'zenbar', position, anchor: { x: r.left, y: r.top, width: r.width, height: r.height } });
    }, LAYOUT.HOVER_OPEN_MS);
  };
  const onLeave = () => (floatsToOverlay ? window.clearTimeout(timer.current) : hoverLeave());

  return (
    <div
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      className="shrink-0"
    >
      {!hovered ? (
        <div
          ref={stripRef}
          className={`h-1.5 w-full bg-zinc-950 hover:bg-indigo-500/30 transition-colors ${
            position === 'top' ? 'border-b border-zinc-900' : 'border-t border-zinc-900'
          }`}
          title="Hover to reveal Zen tabs & address bar"
        />
      ) : (
        <ZenBarContent />
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
      {!isElectron && !isZen && showTopBar && (
        <header data-tauri-drag-region className="app-drag h-8 bg-zinc-900 border-b border-zinc-800 shrink-0" />
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
      {/* Electron draws modals in the overlay view, over the pages. */}
      {!isElectron && (
        <Suspense fallback={null}>
          {importModalOpen && <ImportWizard />}
          {settingsModalOpen && <SettingsModal />}
        </Suspense>
      )}
    </div>
  );
}
