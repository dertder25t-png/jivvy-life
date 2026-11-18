import React, { useEffect } from 'react';
import { useWorkspaceStore } from './store/workspaceStore';
import { Sidebar } from './components/Sidebar';
import { PaneContainer } from './components/PaneContainer';
import { ImportWizard } from './components/ImportWizard';
import { SettingsModal } from './components/SettingsModal';
import { TopTabBar } from './components/TopTabBar';
import { ZenOmnibox } from './components/ZenOmnibox';
import { AddressBar } from './components/AddressBar';
import { HamburgerMenu } from './components/HamburgerMenu';

function hostOf(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return 'web';
  }
}

export default function App() {
  const layoutMode = useWorkspaceStore((s) => s.layoutMode);
  const showTopBar = useWorkspaceStore((s) => s.showTopBar);
  const showSidebar = layoutMode === 'left-vertical' || layoutMode === 'compact-rail';

  // Other parts of the app (dashboard widgets) ask for a URL to be opened in a new, focused web tab.
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
      {/* Optional top header row (hidden in Zen mode or via the "Show top bar" setting) */}
      {layoutMode !== 'zen' && showTopBar && (
        <header data-tauri-drag-region className="h-8 bg-zinc-900 border-b border-zinc-800 shrink-0" />
      )}

      {layoutMode === 'classic-top' && <TopTabBar />}

      {/* Main Workspace Area */}
      <div className="flex-1 flex min-h-0">
        {showSidebar && <Sidebar />}
        <div className="flex-1 flex flex-col min-w-0 min-h-0">
          <AddressBar />
          <PaneContainer />
        </div>
      </div>

      {/* Zen mode: no sidebar, so the menu floats bottom-left */}
      {layoutMode === 'zen' && (
        <div className="fixed bottom-4 left-4 z-40 bg-zinc-900 border border-zinc-800 rounded-lg">
          <HamburgerMenu placement="up" />
        </div>
      )}

      <ZenOmnibox />
      <ImportWizard />
      <SettingsModal />
    </div>
  );
}
