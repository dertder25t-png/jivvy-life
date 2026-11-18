import React, { useEffect } from 'react';
import { Minimize2 } from 'lucide-react';
import { useWorkspaceStore } from './store/workspaceStore';
import { Sidebar } from './components/Sidebar';
import { PaneContainer } from './components/PaneContainer';
import { ImportWizard } from './components/ImportWizard';
import { SettingsModal } from './components/SettingsModal';
import { TopTabBar } from './components/TopTabBar';
import { ZenOmnibox, OmniForm } from './components/ZenOmnibox';
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
          {/* Zen dock: in-flow so the native webview (sized to the pane host) can never cover it */}
          {layoutMode === 'zen' && (
            <div className="shrink-0 h-12 flex items-center gap-3 px-3 bg-zinc-900 border-t border-zinc-800">
              <HamburgerMenu placement="up" />
              <div className="flex-1 min-w-0 max-w-2xl mx-auto rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-1.5 hover:border-zinc-600 transition-colors">
                <OmniForm variant="pill" onDone={() => undefined} />
              </div>
              <button
                type="button"
                onClick={() => useWorkspaceStore.getState().setLayoutMode('left-vertical')}
                className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-zinc-700 bg-zinc-800 text-xs font-medium text-zinc-100 hover:bg-zinc-700 transition-colors"
                title="Exit Zen mode"
              >
                <Minimize2 className="w-4 h-4" />
                Exit Zen
              </button>
            </div>
          )}
        </div>
      </div>

      <ZenOmnibox />
      <ImportWizard />
      <SettingsModal />
    </div>
  );
}
