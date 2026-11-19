import React, { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { Webview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useWorkspaceStore } from '../store/workspaceStore';
import { WorkspaceTab } from '../types/workspace';
import { isOverlayOpen } from '../lib/overlay';
import { DashboardView } from './Dashboard/DashboardView';

const NoteEditor = lazy(() => import('./NoteEditor').then((m) => ({ default: m.NoteEditor })));

const NAV_EVENT = 'lifeapp:nav';
const OVERLAY_EVENT = 'lifeapp:overlay';
const RAIL_EVENT = 'lifeapp:rail';
const MAX_LIVE_WEBVIEWS = 4;
const isTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

interface NativeView {
  wv: Webview;
  url: string;
  ready: Promise<boolean>;
  lastUsed: number;
  hiddenAt?: number;
}
const views = new Map<string, NativeView>();

// Background tabs: pause their media when hidden, and unload them entirely after they've
// been out of sight this long (they reload when you come back to them).
const SLEEP_AFTER_MS = 15 * 60 * 1000;
function markHidden(v: NativeView) {
  v.hiddenAt = Date.now();
  void invoke('nav_pane', { label: v.wv.label, action: 'pause' }).catch(() => {});
}
function markShown(v: NativeView) {
  v.hiddenAt = undefined;
  v.lastUsed = Date.now();
}
if (typeof window !== 'undefined') {
  window.setInterval(() => {
    const visible = visibleTabIds();
    const now = Date.now();
    for (const [id, v] of views) {
      if (!visible.has(id) && v.hiddenAt && now - v.hiddenAt > SLEEP_AFTER_MS) void destroyView(id);
    }
  }, 60_000);
}

// Native events from lib.rs: popup/target=_blank links become new tabs, and pane
// webviews report their real title/URL so the tab label isn't stale.
let nativeListenersReady = false;
function setupNativeListeners() {
  if (nativeListenersReady || !isTauri()) return;
  nativeListenersReady = true;
  void listen<{ url: string }>('lifeapp:new-tab', ({ payload }) => {
    const url = payload?.url;
    if (!url || !/^https?:/i.test(url)) return;
    let title = url;
    try {
      title = new URL(url).hostname.replace(/^www\./, '');
    } catch {}
    useWorkspaceStore.getState().openTab({ title, type: 'web', url });
  });
  void listen<{ label: string; url: string; title: string }>('lifeapp:page', ({ payload }) => {
    if (!payload?.label?.startsWith('pane_') || !payload.url) return;
    const tabId = payload.label.slice('pane_'.length);
    // Record the URL on the live view first so the pane effect doesn't recreate it.
    const v = views.get(tabId);
    if (v) v.url = payload.url;
    useWorkspaceStore.getState().syncTabFromPage(tabId, payload.url, payload.title);
  });
}
const chains = new Map<string, Promise<unknown>>();
const enqueue = <T,>(tabId: string, fn: () => Promise<T>): Promise<T> => {
  const next = (chains.get(tabId) ?? Promise.resolve()).catch(() => {}).then(fn);
  chains.set(tabId, next);
  return next;
};

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
const rectOf = (el: HTMLElement): Rect => {
  const r = el.getBoundingClientRect();
  return {
    x: Math.round(r.left),
    y: Math.round(r.top),
    width: Math.max(1, Math.round(r.width)),
    height: Math.max(1, Math.round(r.height)),
  };
};

function destroyView(tabId: string) {
  return enqueue(tabId, async () => {
    const v = views.get(tabId);
    if (!v) return;
    views.delete(tabId);
    await v.ready;
    await v.wv.close().catch(() => {});
  });
}

function visibleTabIds(): Set<string> {
  const st = useWorkspaceStore.getState();
  const ws = st.workspaces.find((w) => w.id === st.activeWorkspaceId);
  const ids = new Set<string>();
  if (ws?.primaryTabId) ids.add(ws.primaryTabId);
  if (ws?.secondaryTabId) ids.add(ws.secondaryTabId);
  return ids;
}

function evictOldestIfNeeded() {
  if (views.size <= MAX_LIVE_WEBVIEWS) return;
  const keepIds = visibleTabIds();
  const candidates = [...views.entries()]
    .filter(([id]) => !keepIds.has(id))
    .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  while (views.size > MAX_LIVE_WEBVIEWS && candidates.length > 0) {
    const [victimId] = candidates.shift()!;
    void destroyView(victimId);
  }
}

// Creates the native webview once per tab; URL changes go through load_pane, never recreate.
function ensureView(tabId: string, url: string, rect: Rect): Promise<NativeView | null> {
  return enqueue(tabId, async () => {
    const existing = views.get(tabId);
    if (existing) {
      existing.lastUsed = Date.now();
      return (await existing.ready) ? existing : null;
    }
    const wv = new Webview(getCurrentWindow(), `pane_${tabId}`, { url, ...rect });
    const ready = new Promise<boolean>((resolve) => {
      void wv.once('tauri://created', () => resolve(true));
      void wv.once('tauri://error', () => {
        views.delete(tabId);
        resolve(false);
      });
    });
    const view: NativeView = { wv, url, ready, lastUsed: Date.now() };
    views.set(tabId, view);
    const ok = await ready;
    if (ok) {
      void invoke('configure_pane', { label: wv.label }).catch(() => {});
      evictOldestIfNeeded();
    }
    return ok ? view : null;
  });
}

let rail = { expanded: false, width: 256 };

function useOverlayHidden(): boolean {
  const modalOpen = useWorkspaceStore((s) => s.importModalOpen || s.settingsModalOpen);
  const [overlay, setOverlay] = useState(isOverlayOpen);
  useEffect(() => {
    const onOverlay = () => setOverlay(isOverlayOpen());
    onOverlay();
    window.addEventListener(OVERLAY_EVENT, onOverlay);
    return () => window.removeEventListener(OVERLAY_EVENT, onOverlay);
  }, []);
  return modalOpen || overlay;
}

const NativeWebPane: React.FC<{ tab: WorkspaceTab; primary: boolean }> = ({ tab, primary }) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const lastApplied = useRef<string>('');
  const hidden = useOverlayHidden();
  const url = tab.url ?? 'about:blank';
  const urlRef = useRef(url);
  urlRef.current = url;
  const shown = useRef(false);

  // User-initiated navigation (address bar): navigate the live webview in place.
  useEffect(() => {
    const id = tab.id;
    void enqueue(id, async () => {
      const v = views.get(id);
      if (!v || !(await v.ready)) return;
      const target = urlRef.current;
      if (v.url === target) return;
      v.url = target;
      await invoke('load_pane', { label: `pane_${id}`, url: target }).catch(() => {});
    });
  }, [tab.id, url]);

  // Real in-page Back / Forward / Reload via Rust Webview eval
  useEffect(() => {
    if (!primary) return;
    const onNav = (e: Event) => {
      const action = (e as CustomEvent<{ action: 'back' | 'forward' | 'reload' }>).detail?.action;
      if (!action) return;
      void invoke('nav_pane', { label: `pane_${tab.id}`, action }).catch(() => {});
    };
    window.addEventListener(NAV_EVENT, onNav);
    return () => window.removeEventListener(NAV_EVENT, onNav);
  }, [primary, tab.id]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let raf = 0;
    let view: NativeView | null = null;
    shown.current = false;
    lastApplied.current = '';

    const apply = (force = false) => {
      raf = 0;
      if (!view || cancelled) return;
      const r = rectOf(host);
      if (rail.expanded) {
        const shift = Math.max(0, rail.width - r.x);
        r.x += shift;
        r.width = Math.max(1, r.width - shift);
      }
      const sig = `${r.x},${r.y},${r.width},${r.height},${hidden}`;
      if (!force && sig === lastApplied.current) return;
      lastApplied.current = sig;

      if (hidden) {
        shown.current = false;
        markHidden(view);
        void view.wv.hide().catch(() => {});
        return;
      }
      if (!shown.current) {
        shown.current = true;
        markShown(view);
        void view.wv.show().catch(() => {});
      }
      void invoke('place_pane', { label: view.wv.label, x: r.x, y: r.y, width: r.width, height: r.height }).catch(() => {});
    };

    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(() => apply(false));
    };

    void ensureView(tab.id, urlRef.current, rectOf(host)).then((v) => {
      if (cancelled || !v) return;
      view = v;
      apply(true);
    });

    const onRail = (e: Event) => {
      const d = (e as CustomEvent<{ expanded: boolean; width: number }>).detail;
      rail = { expanded: !!d?.expanded, width: d?.width ?? 256 };
      schedule();
    };
    window.addEventListener(RAIL_EVENT, onRail);
    const ro = new ResizeObserver(schedule);
    ro.observe(host);
    if (host.parentElement) ro.observe(host.parentElement);
    window.addEventListener('resize', schedule);

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener(RAIL_EVENT, onRail);
      shown.current = false;
      const v = views.get(tab.id);
      if (v) {
        markHidden(v);
        void v.ready.then(() => v.wv.hide().catch(() => {}));
      }
    };
  }, [tab.id, hidden]);

  return (
    <div className="flex-1 flex flex-col h-full bg-zinc-950 min-w-0">
      <div ref={hostRef} className="flex-1 min-h-0 w-full bg-zinc-950" />
    </div>
  );
};

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
        <Suspense fallback={<div className="p-6 text-xs text-zinc-500">Loading editor…</div>}>
          <NoteEditor noteId={tab.noteId!} />
        </Suspense>
      </div>
    );
  }
  return isTauri() ? <NativeWebPane key={tab.id} tab={tab} primary={primary} /> : <IframePane tab={tab} />;
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
  const idsKey = useWorkspaceStore((s) => s.workspaces.map((w) => w.tabs.map((t) => t.id).join(',')).join('|'));

  const allTabIds = useMemo(() => new Set(idsKey.split(/[|,]/).filter(Boolean)), [idsKey]);
  useEffect(() => {
    if (!isTauri()) return;
    for (const id of [...views.keys()]) if (!allTabIds.has(id)) void destroyView(id);
  }, [allTabIds]);

  return (
    <div className="flex-1 flex h-full min-w-0 divide-x divide-zinc-800">
      <SinglePane tab={primaryTab} primary />
      {split && <SinglePane tab={secondaryTab} primary={false} />}
    </div>
  );
};

setupNativeListeners();
