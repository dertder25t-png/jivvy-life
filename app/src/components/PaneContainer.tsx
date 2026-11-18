import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Webview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { LogicalPosition, LogicalSize } from '@tauri-apps/api/dpi';
import { invoke } from '@tauri-apps/api/core';
import { useWorkspaceStore } from '../store/workspaceStore';
import { WorkspaceTab } from '../types/workspace';
import { NoteEditor } from './NoteEditor';
import { DashboardView } from './Dashboard/DashboardView';

const NAV_EVENT = 'lifeapp:nav'; // same constant as TopTabBar (kept local to avoid a component import cycle)
const OVERLAY_EVENT = 'lifeapp:overlay';
const RAIL_EVENT = 'lifeapp:rail';
const isTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/* ------------------------------------------------------------------ */
/* Tauri 2 native child-webview adapter                                */
/* ------------------------------------------------------------------ */

interface NativeView {
  wv: Webview;
  url: string;
  ready: Promise<boolean>;
}
const views = new Map<string, NativeView>();
// Serialise create/close per tab so a recreate never races the old label.
const chains = new Map<string, Promise<unknown>>();
const enqueue = <T,>(tabId: string, fn: () => Promise<T>): Promise<T> => {
  const next = (chains.get(tabId) ?? Promise.resolve()).catch(() => {}).then(fn);
  chains.set(tabId, next);
  return next;
};

// Per-tab history of URLs we navigated to. The Tauri JS API has no goBack/eval, so back/forward
// re-points the child webview at the previous/next URL we know about.
const history = new Map<string, { stack: string[]; idx: number }>();
function trackUrl(tabId: string, url: string) {
  const h = history.get(tabId) ?? { stack: [], idx: -1 };
  if (h.stack[h.idx] !== url) {
    h.stack = [...h.stack.slice(0, h.idx + 1), url];
    h.idx = h.stack.length - 1;
  }
  history.set(tabId, h);
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
const rectOf = (el: HTMLElement): Rect => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: Math.max(1, r.width), height: Math.max(1, r.height) };
};

function ensureView(tabId: string, url: string, rect: Rect): Promise<NativeView | null> {
  return enqueue(tabId, async () => {
    const existing = views.get(tabId);
    if (existing && existing.url === url) return (await existing.ready) ? existing : null;
    if (existing) {
      views.delete(tabId);
      await existing.ready;
      await existing.wv.close().catch(() => {});
    }
    const wv = new Webview(getCurrentWindow(), `pane_${tabId}`, { url, ...rect });
    const ready = new Promise<boolean>((resolve) => {
      void wv.once('tauri://created', () => resolve(true));
      void wv.once('tauri://error', () => {
        views.delete(tabId);
        resolve(false);
      });
    });
    const view: NativeView = { wv, url, ready };
    views.set(tabId, view);
    return (await ready) ? view : null;
  });
}

function destroyView(tabId: string) {
  history.delete(tabId);
  return enqueue(tabId, async () => {
    const v = views.get(tabId);
    if (!v) return;
    views.delete(tabId);
    await v.ready;
    await v.wv.close().catch(() => {});
  });
}

// Latest rail state (shared so newly-mounted panes start correct).
var rail = { expanded: false, width: 256 };

function useOverlayHidden(): boolean {
  const modalOpen = useWorkspaceStore((s) => s.importModalOpen || s.settingsModalOpen);
  const [overlay, setOverlay] = useState(false);
  useEffect(() => {
    const onOverlay = (e: Event) => setOverlay(!!(e as CustomEvent<{ open: boolean }>).detail?.open);
    window.addEventListener(OVERLAY_EVENT, onOverlay);
    return () => window.removeEventListener(OVERLAY_EVENT, onOverlay);
  }, []);
  return modalOpen || overlay;
}

const NativeWebPane: React.FC<{ tab: WorkspaceTab; primary: boolean }> = ({ tab, primary }) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const hidden = useOverlayHidden();
  const [nonce, setNonce] = useState(0); // bump to force recreate (reload / back / forward)
  const [urlOverride, setUrlOverride] = useState<string | null>(null);
  const url = urlOverride ?? tab.url ?? 'about:blank';

  // A new tab.url from the store resets any history override.
  useEffect(() => setUrlOverride(null), [tab.id, tab.url]);
  useEffect(() => trackUrl(tab.id, tab.url ?? 'about:blank'), [tab.id, tab.url]);

  // Back / forward / reload (only the primary pane listens, matching the TopTabBar buttons).
  useEffect(() => {
    if (!primary) return;
    const onNav = (e: Event) => {
      const action = (e as CustomEvent<{ action: 'back' | 'forward' | 'reload' }>).detail?.action;
      const h = history.get(tab.id);
      if (action === 'reload') {
        void destroyView(tab.id).then(() => setNonce((n) => n + 1));
      } else if (h && (action === 'back' || action === 'forward')) {
        const idx = h.idx + (action === 'back' ? -1 : 1);
        if (idx < 0 || idx >= h.stack.length) return;
        h.idx = idx;
        setUrlOverride(h.stack[idx]);
      }
    };
    window.addEventListener(NAV_EVENT, onNav);
    return () => window.removeEventListener(NAV_EVENT, onNav);
  }, [primary, tab.id]);

  // Create / position / show, and keep matching the host rect.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let raf = 0;
    let view: NativeView | null = null;

    const apply = () => {
      raf = 0;
      if (!view || cancelled) return;
      const r = rectOf(host);
      // Hover-expanded compact rail floats over the workspace: push the native webview clear of it.
      if (rail.expanded) {
        const shift = Math.max(0, rail.width - r.x);
        r.x += shift;
        r.width = Math.max(1, r.width - shift);
      }
      void view.wv.setPosition(new LogicalPosition(r.x, r.y)).catch(() => {});
      void view.wv.setSize(new LogicalSize(r.width, r.height)).catch(() => {});
      // Linux: child webviews live in a GtkBox and ignore setPosition/setSize; Rust re-parents them.
      void invoke('place_pane', { label: view.wv.label, x: r.x, y: r.y, width: r.width, height: r.height }).catch(() => {});
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(apply);
    };

    void ensureView(tab.id, url, rectOf(host)).then(async (v) => {
      if (cancelled || !v) return;
      view = v;
      apply();
      await (hidden ? v.wv.hide() : v.wv.show()).catch(() => {});
    });

    const onRail = (e: Event) => {
      const d = (e as CustomEvent<{ expanded: boolean; width: number }>).detail;
      rail = { expanded: !!d?.expanded, width: d?.width ?? 256 };
      schedule();
    };
    window.addEventListener(RAIL_EVENT, onRail);
    const ro = new ResizeObserver(schedule);
    ro.observe(host);
    window.addEventListener('resize', schedule);
    // Layout shifts (sidebar toggle) that don't resize the host still move it.
    const poll = window.setInterval(schedule, 500);

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener(RAIL_EVENT, onRail);
      window.clearInterval(poll);
      // Tab switched away or pane unmounted: hide (keeps page state); destroyed on tab close.
      const v = views.get(tab.id);
      if (v) void v.ready.then(() => v.wv.hide().catch(() => {}));
    };
  }, [tab.id, url, nonce, hidden]);

  return (
    <div className="flex-1 flex flex-col h-full bg-zinc-950 min-w-0">
      <div ref={hostRef} className="flex-1 min-h-0 w-full bg-zinc-950" />
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Panes                                                               */
/* ------------------------------------------------------------------ */

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

const SinglePane: React.FC<{ tab?: WorkspaceTab; primary: boolean }> = ({ tab, primary }) => {
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
        <NoteEditor noteId={tab.noteId!} />
      </div>
    );
  }
  return isTauri() ? <NativeWebPane key={tab.id} tab={tab} primary={primary} /> : <IframePane tab={tab} />;
};

export const PaneContainer: React.FC = () => {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const activeWs = workspaces.find((w) => w.id === activeWorkspaceId);
  const primaryTab = activeWs?.tabs.find((t) => t.id === activeWs.primaryTabId);
  const secondaryTab = activeWs?.tabs.find((t) => t.id === activeWs.secondaryTabId);

  // Destroy native webviews whose tab no longer exists in any workspace.
  const allTabIds = useMemo(() => new Set(workspaces.flatMap((w) => w.tabs.map((t) => t.id))), [workspaces]);
  useEffect(() => {
    if (!isTauri()) return;
    for (const id of [...views.keys()]) if (!allTabIds.has(id)) void destroyView(id);
  }, [allTabIds]);

  return (
    <div className="flex-1 flex h-full min-w-0 divide-x divide-zinc-800">
      <SinglePane tab={primaryTab} primary />
      {activeWs?.layout === 'split-vertical' && <SinglePane tab={secondaryTab} primary={false} />}
    </div>
  );
};
