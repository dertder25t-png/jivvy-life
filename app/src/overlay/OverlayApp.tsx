// The Electron overlay view: a transparent WebContentsView above the web pages that draws
// whatever must float over them (menus, palette, modals, hover-revealed rail and bars).
// It lays out in window coordinates inside #overlay-layer, measures what it drew and asks main
// to shrink the view to that area, so it never eats clicks meant for the page.
import React, { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { jivvy, openOverlay, setOverlayWindowSize } from '../platform';
import { HOVER_KINDS, type OverlayMessage, type OverlaySpec } from '../../shared/ipc';
import { LAYOUT, type Rect } from '../../shared/layout';
import { useWorkspaceStore } from '../store/workspaceStore';
import { HamburgerPanel, menuPos, CLEAR_TABS_CONFIRM } from '../components/HamburgerMenu';
import { Sidebar, TabContextMenu } from '../components/Sidebar';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { OmniboxPalette } from '../components/ZenOmnibox';
import { AddressBar, SuggestRows } from '../components/AddressBar';
import { ZenBarContent } from '../App';
import { Hud } from './Hud';
import { DownloadsPanel } from '../components/Downloads';

const ImportWizard = lazy(() => import('../components/ImportWizard').then((m) => ({ default: m.ImportWizard })));
const SettingsModal = lazy(() => import('../components/SettingsModal').then((m) => ({ default: m.SettingsModal })));

/** Modals cover the whole window (dimmed backdrop), so they never need measuring. */
const FULL_KINDS: OverlaySpec['kind'][] = ['confirm', 'omnibox', 'settings', 'import'];
/** Room for drop shadows around popups. */
const MARGIN = 24;

/** Wraps hover-revealed surfaces: closes when the pointer leaves (unless typing or a popup is open). */
const HoverSurface: React.FC<{ style: React.CSSProperties; onClose: () => void; children: React.ReactNode }> = ({ style, onClose, children }) => {
  const timer = useRef(0);
  const inside = useRef(true);
  const ref = useRef<HTMLDivElement>(null);
  const maybeClose = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const layer = document.getElementById('overlay-layer');
      const nestedPopup = !!layer && layer.children.length > 1;
      const typing = !!ref.current && ref.current.contains(document.activeElement) && /^(INPUT|TEXTAREA)$/.test(document.activeElement!.tagName);
      if (!inside.current && !nestedPopup && !typing) onClose();
    }, LAYOUT.HOVER_CLOSE_MS);
  }, [onClose]);
  useEffect(() => {
    // The pointer can leave the whole view in one jump (fast move onto the page).
    const onDocLeave = () => {
      inside.current = false;
      maybeClose();
    };
    document.documentElement.addEventListener('mouseleave', onDocLeave);
    return () => {
      window.clearTimeout(timer.current);
      document.documentElement.removeEventListener('mouseleave', onDocLeave);
    };
  }, [maybeClose]);
  return (
    <div
      ref={ref}
      style={style}
      onMouseEnter={() => {
        inside.current = true;
        window.clearTimeout(timer.current);
      }}
      onMouseLeave={() => {
        inside.current = false;
        maybeClose();
      }}
      onBlur={() => maybeClose()}
    >
      {children}
    </div>
  );
};

const Surface: React.FC<{ spec: OverlaySpec; win: { width: number; height: number }; close: () => void }> = ({ spec, win, close }) => {
  switch (spec.kind) {
    case 'menu':
      return <HamburgerPanel placement={spec.placement} pos={menuPos(spec.anchor)} onClose={close} onClearTabs={() => openOverlay(CLEAR_TABS_CONFIRM)} />;
    case 'tabmenu':
      return <TabContextMenu tabId={spec.tabId} x={spec.x} y={spec.y} onClose={close} onEditFolder={(id) => jivvy?.emit({ type: 'edit-folder', id })} />;
    case 'confirm':
      return (
        <ConfirmDialog
          title={spec.title}
          body={spec.body}
          confirmLabel={spec.confirmLabel}
          onCancel={close}
          onConfirm={() => {
            jivvy?.dispatch(spec.action);
            close();
          }}
        />
      );
    case 'omnibox':
      return <OmniboxPalette open onClose={close} />;
    case 'settings':
      return (
        <Suspense fallback={null}>
          <SettingsModal />
        </Suspense>
      );
    case 'import':
      return (
        <Suspense fallback={null}>
          <ImportWizard />
        </Suspense>
      );
    case 'rail':
      return (
        <HoverSurface
          onClose={close}
          style={{ position: 'fixed', left: spec.anchor.x, top: spec.anchor.y, height: spec.anchor.height, width: LAYOUT.SIDEBAR_W }}
        >
          <Sidebar floating />
        </HoverSurface>
      );
    case 'zenbar':
      return (
        <HoverSurface onClose={close} style={{ position: 'fixed', left: 0, width: win.width, ...(spec.position === 'top' ? { top: 0 } : { bottom: 0 }) }}>
          <ZenBarContent />
        </HoverSurface>
      );
    case 'hud':
      return <Hud anchor={spec.anchor} />;
    case 'downloads':
      return <DownloadsPanel anchor={spec.anchor} />;
    case 'suggest':
      return (
        <div style={{ position: 'fixed', left: spec.anchor.x, top: spec.anchor.y, width: spec.anchor.width }}>
          <SuggestRows items={spec.items} selected={spec.selected} onPick={(index) => jivvy?.emit({ type: 'suggest-pick', index })} />
        </div>
      );
    case 'addressbar':
      return (
        <HoverSurface onClose={close} style={{ position: 'fixed', left: spec.anchor.x, top: spec.anchor.y, width: spec.anchor.width }}>
          <AddressBar floating autoFocus={!!spec.focus} />
        </HoverSurface>
      );
  }
};

export default function OverlayApp() {
  const [msg, setMsg] = useState<OverlayMessage | null>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const origin = useRef({ x: 0, y: 0 });
  const last = useRef('');

  useEffect(
    () =>
      jivvy?.onOverlay((m) => {
        setOverlayWindowSize(m.win);
        useWorkspaceStore.setState({ settingsModalOpen: m.spec?.kind === 'settings', importModalOpen: m.spec?.kind === 'import' });
        setMsg(m);
      }),
    []
  );

  const seq = msg?.seq ?? 0;
  const close = useCallback(() => jivvy?.overlayClose(seq), [seq]);

  // Measure what the layer drew (window coordinates), shift the layer so it lines up once main
  // has moved the view there, and report the rect. null = cover the whole window.
  const measure = useCallback(
    (fresh: boolean) => {
      const layer = layerRef.current;
      if (!layer || !msg?.spec) return;
      const { width: W, height: H } = msg.win;
      let rect: Rect | null = null;
      if (!FULL_KINDS.includes(msg.spec.kind)) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const el of Array.from(layer.children)) {
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) continue;
          x0 = Math.min(x0, r.left + origin.current.x);
          y0 = Math.min(y0, r.top + origin.current.y);
          x1 = Math.max(x1, r.right + origin.current.x);
          y1 = Math.max(y1, r.bottom + origin.current.y);
        }
        if (x0 === Infinity) return; // nothing drawn yet
        if (!(x0 <= 0 && y0 <= 0 && x1 >= W && y1 >= H)) {
          const l = Math.max(0, Math.floor(x0 - MARGIN));
          const t = Math.max(0, Math.floor(y0 - MARGIN));
          rect = { x: l, y: t, width: Math.min(W, Math.ceil(x1 + MARGIN)) - l, height: Math.min(H, Math.ceil(y1 + MARGIN)) - t };
        }
      }
      const key = JSON.stringify(rect);
      if (!fresh && key === last.current) return;
      last.current = key;
      origin.current = rect ? { x: rect.x, y: rect.y } : { x: 0, y: 0 };
      layer.style.transform = `translate(${-origin.current.x}px, ${-origin.current.y}px)`;
      jivvy?.overlayReady(msg.seq, rect);
    },
    [msg]
  );

  useLayoutEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    origin.current = { x: 0, y: 0 };
    layer.style.transform = 'translate(0px, 0px)';
    last.current = '';
    if (!msg?.spec) return;
    measure(true);
    // Re-measure when the content changes size (nested popups, lazy modals, list updates).
    let t = 0;
    const schedule = () => {
      window.clearTimeout(t);
      t = window.setTimeout(() => measure(false), 0);
    };
    const mo = new MutationObserver(schedule);
    mo.observe(layer, { childList: true, subtree: true, attributes: true, characterData: true });
    return () => {
      mo.disconnect();
      window.clearTimeout(t);
    };
  }, [msg, measure]);

  useEffect(() => {
    if (!msg?.spec) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && msg.spec?.kind !== 'hud') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [msg, close]);

  const win = msg?.win ?? { width: window.innerWidth, height: window.innerHeight };
  const hover = msg?.spec && HOVER_KINDS.includes(msg.spec.kind);
  return (
    <div
      id="overlay-layer"
      ref={layerRef}
      data-hover={hover ? '' : undefined}
      style={{ position: 'fixed', left: 0, top: 0, width: win.width, height: win.height, transform: 'translate(0px, 0px)' }}
    >
      {msg?.spec && <Surface key={msg.seq} spec={msg.spec} win={win} close={close} />}
    </div>
  );
}
