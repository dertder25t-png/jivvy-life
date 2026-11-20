// Jivvy Life, Electron main process.
// One BaseWindow holding: the base UI view (full window, app chrome), the web page views
// (WebContentsViews placed by main from shared layout constants) and one transparent overlay
// view for anything that floats over the pages. Main owns all state (see store.ts).
import { app, BaseWindow, BrowserWindow, WebContentsView, ipcMain, session, Menu, protocol, net, screen, type Input, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents, type Session } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { StateStore } from './store';
import { TabManager } from './tabs';
import { Blocker } from './blocker';
import { HistoryStore } from './history';
import { googleSignIn } from './google-auth';
import { Trainer } from './trainer';
import { lagOp, startLagMon } from './lagmon';
import { MemorySaver, readProcMeminfo } from './memsaver';
import { runSelfTest } from './selftest';
import { Logins } from './logins';
import { autoMigrate, defaultTauriDir, dryRun, fileStateIO, runMigration, summaryText, takeMigratedDash, type MigrationReport } from './migrate-tauri';
import { Downloads } from './downloads';
import { Permissions } from './permissions';
import { buildPageMenu, type MenuDeps } from './contextmenu';
import { decide } from '../shared/lifeboard/router';
import { levelFor, percentFor, stepZoom } from '../shared/zoom';
import { readBrief, openPath } from './native';
import { validateAction, INTERNAL_ACTIONS, isAllowedTabUrl, type Action, type PersistedState } from '../shared/state';
import { CH, HOVER_KINDS, BLUR_KINDS, EMPTY_HUD, type HudState, type SuggestItem, type NavAction, type OverlaySpec, type RuntimeState, type StatePatch, type UiEvent, type ImportStatus } from '../shared/ipc';
import { LAYOUT, addressBarRect, chromeInsets, cubicBezier, edgeStripRect, pageRects, type Rect } from '../shared/layout';

const log = (...a: unknown[]) => console.error('[jivvy]', ...a);

// ---- Modes & paths ----------------------------------------------------------------------------
const DEV_URL = process.env.JIVVY_DEV_URL?.replace(/\/$/, '') || '';
const SELFTEST = process.env.JIVVY_SELFTEST !== undefined && process.env.JIVVY_SELFTEST !== '' && process.env.JIVVY_SELFTEST !== '0';
const SNAPSHOT = process.env.JIVVY_SNAPSHOT === '1';
const RENDERER_DIR = path.join(__dirname, '..', 'dist');
const UI_ORIGIN = DEV_URL || 'app://jivvy';

// Separate profile (tests, side-by-side runs): --user-data-dir=PATH or JIVVY_USER_DATA.
const udArg = process.argv.find((a) => a.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length);
const userData = udArg || process.env.JIVVY_USER_DATA;
// Default profile is pinned to ~/.config/jivvy-life: Electron would otherwise derive it from
// productName ("Jivvy Life") and silently start a fresh, empty profile.
app.setPath('userData', userData ? path.resolve(userData) : path.join(app.getPath('appData'), 'jivvy-life'));

// ---- Chromium flags: Wayland with fractional scaling, server-side decorations ---------------
if (!app.commandLine.hasSwitch('ozone-platform-hint') && !app.commandLine.hasSwitch('ozone-platform'))
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
if (!app.commandLine.hasSwitch('enable-features')) app.commandLine.appendSwitch('enable-features', 'WaylandWindowDecorations');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
]);

// ---- Content security policy for the UI views ------------------------------------------------
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https: http:",
  "font-src 'self' data:",
  "connect-src 'self' https:",
  "media-src 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');
// Vite dev server needs inline (React refresh preamble) and ws: for HMR.
const DEV_CSP = CSP.replace("script-src 'self' 'wasm-unsafe-eval'", "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'").replace(
  "connect-src 'self' https:",
  `connect-src 'self' https: ${DEV_URL.replace(/^http/, 'ws')}`
);

// ---- Globals ---------------------------------------------------------------------------------
let win: BaseWindow | null = null;
let base: WebContentsView | null = null;
let overlay: WebContentsView | null = null;
let overlayLoaded = false;
let edge: WebContentsView | null = null; // invisible top-edge hover strip over the pages
let edgeAttached = false;
let store: StateStore;
let tabs: TabManager;
let memsaver: MemorySaver;
let history: HistoryStore;
let trainer: Trainer;
let logins: Logins;
let startupMigration: MigrationReport | null = null;
let migrating = false;
let pageSession: Session;
let downloads: Downloads;
let perms: Permissions;
const blocker = new Blocker();
const runtime: RuntimeState = { tabs: {}, fullscreenTabId: null, overlay: null, blocking: { ready: false, rules: 0 }, downloads: [], hud: EMPTY_HUD };

// ---- State broadcast (coalesced per tick) ----------------------------------------------------
let pendingPersist: Partial<PersistedState> = {};
let pendingRuntime = false;
let flushQueued = false;
function uiContents(): WebContents[] {
  return [base, overlay, edge].filter((v): v is WebContentsView => !!v && !v.webContents.isDestroyed()).map((v) => v.webContents);
}
function queueFlush() {
  if (flushQueued) return;
  flushQueued = true;
  setImmediate(() => {
    flushQueued = false;
    const patch: StatePatch = {};
    if (Object.keys(pendingPersist).length) patch.persist = pendingPersist;
    if (pendingRuntime) patch.runtime = runtime;
    pendingPersist = {};
    pendingRuntime = false;
    if (!patch.persist && !patch.runtime) return;
    for (const wc of uiContents()) wc.send(CH.patch, patch);
  });
}
function runtimeChanged() {
  pendingRuntime = true;
  queueFlush();
}

// ---- Layout ----------------------------------------------------------------------------------
const ease = cubicBezier(...LAYOUT.EASE);
let animLeft: number | undefined;
let anim: { timer: NodeJS.Timeout } | null = null;

function activeWorkspace() {
  const s = store.state;
  return s.workspaces.find((w) => w.id === s.activeWorkspaceId) ?? s.workspaces[0];
}
const isPageTab = (t?: { type: string; url?: string }) => !!t && (t.type === 'web' || t.type === 'jivvy') && !!t.url;

function layoutInput() {
  const s = store.state;
  const { width, height } = win!.getContentBounds();
  return {
    width,
    height,
    layoutMode: s.layoutMode,
    showTopBar: s.showTopBar,
    autoHideAddressBar: s.autoHideAddressBar,
    zenBarPosition: s.zenBarPosition,
    split: activeWorkspace()?.layout === 'split-vertical',
  };
}

/** Compute every view's bounds from state and set them, all in this one synchronous call. */
function applyLayout() {
  if (!win || !base) return;
  const li = layoutInput();
  base.setBounds({ x: 0, y: 0, width: li.width, height: li.height });
  const fs = runtime.fullscreenTabId;
  if (fs) {
    const lt = tabs.live.get(fs);
    if (lt) tabs.place(lt, { x: 0, y: 0, width: li.width, height: li.height });
  } else {
    const ws = activeWorkspace();
    const rects = pageRects(li, animLeft);
    const p = tabs.live.get(ws?.primaryTabId ?? '');
    if (p?.attached) tabs.place(p, rects.primary);
    const sId = ws?.secondaryTabId;
    const sec = sId && rects.secondary ? tabs.live.get(sId) : undefined;
    if (sec?.attached && rects.secondary) tabs.place(sec, rects.secondary);
  }
  if (overlay && ovAttached) overlay.setBounds(ovRect ?? { x: 0, y: 0, width: li.width, height: li.height });
  placeEdge(li);
}

/** The hover strip exists only while the address bar auto-hides; it is hidden while any overlay
 *  (including the floating address bar itself) is open, and during page fullscreen. */
function placeEdge(li = layoutInput()) {
  if (!win) return;
  // The HUD (find bar, zoom, prompts) sits in a corner and does not block the strip.
  const r = runtime.fullscreenTabId || (ovAttached && ovSpec?.kind !== 'hud') ? null : edgeStripRect(li);
  if (!r) {
    if (edge && edgeAttached) {
      win.contentView.removeChildView(edge);
      edgeAttached = false;
    }
    return;
  }
  if (!edge) {
    edge = new WebContentsView({ webPreferences: uiPrefs() });
    edge.setBackgroundColor('#00000000');
    guardUi(edge.webContents);
    loadUi(edge.webContents, '#edge');
  }
  edge.setBounds(r);
  if (!edgeAttached) {
    win.contentView.addChildView(edge); // top of the stack: above the pages
    edgeAttached = true;
  }
}

/** Float the address bar over the page where it would sit. */
function openFloatingAddressBar(focus: boolean) {
  openOverlay({ kind: 'addressbar', anchor: addressBarRect(layoutInput()), focus });
}

/** Animate the sidebar edge; the base view runs the same CSS transition on its side. */
function animateLeft(from: number, to: number) {
  if (anim) clearInterval(anim.timer);
  const t0 = performance.now();
  animLeft = from;
  const step = () => {
    const t = Math.min(1, (performance.now() - t0) / LAYOUT.ANIM_MS);
    animLeft = from + (to - from) * ease(t);
    if (t >= 1) {
      clearInterval(anim!.timer);
      anim = null;
      animLeft = undefined;
    }
    applyLayout();
  };
  anim = { timer: setInterval(step, 1000 / 60) };
  step();
}

/** Bring the page views in line with state: create, load, attach, detach, destroy. */
let lastPrimary: string | null = null;
function reconcile() {
  if (!win) return;
  const s = store.state;
  const all = new Map<string, { url?: string; type: string }>();
  for (const w of s.workspaces) for (const t of w.tabs) all.set(t.id, t);
  for (const id of [...tabs.live.keys()]) if (!isPageTab(all.get(id))) tabs.destroy(id);
  for (const id of Object.keys(runtime.tabs)) if (!all.has(id)) tabs.destroy(id);

  // URL changed in state (address bar, dashboard links): navigate the live view in place.
  for (const [id, lt] of tabs.live) {
    const url = all.get(id)?.url;
    if (url && url !== lt.knownUrl) tabs.load(lt, url);
  }

  const ws = activeWorkspace();
  const want: string[] = [];
  const fs = runtime.fullscreenTabId;
  if (fs && tabs.live.has(fs)) want.push(fs);
  else if (ws) {
    const p = ws.tabs.find((t) => t.id === ws.primaryTabId);
    if (isPageTab(p)) want.push(p!.id);
    if (ws.layout === 'split-vertical') {
      const sec = ws.tabs.find((t) => t.id === ws.secondaryTabId);
      if (isPageTab(sec) && sec!.id !== p?.id) want.push(sec!.id);
    }
  }
  for (const [id, lt] of tabs.live) if (!want.includes(id)) tabs.attach(lt, false);
  for (const id of want) tabs.attach(tabs.ensure(id, all.get(id)!.url!), true);
  applyLayout();
  memsaver?.kick();

  // Focus follows the primary tab, like a browser.
  const primary = ws?.primaryTabId ?? null;
  if (primary !== lastPrimary) {
    lastPrimary = primary;
    if (runtime.hud.find && runtime.hud.find.tabId !== primary) closeFind(false);
    if (!ovSpec || HOVER_KINDS.includes(ovSpec.kind) || ovSpec.kind === 'hud') {
      const wc = primary ? tabs.webContentsOf(primary) : null;
      if (wc) wc.focus();
      else base?.webContents.focus();
    }
  }
}

function onStoreChange(changed: Partial<PersistedState>, prev: PersistedState) {
  Object.assign(pendingPersist, changed);
  queueFlush();
  if ('blockingEnabled' in changed || 'blockingDisabledSites' in changed)
    blocker.configure(store.state.blockingEnabled, store.state.blockingDisabledSites);
  if ('layoutMode' in changed && win) {
    const a = chromeInsets(prev);
    const b = chromeInsets(store.state);
    if (a.sidebar && b.sidebar && a.left !== b.left && a.top === b.top) animateLeft(animLeft ?? a.left, b.left);
  }
  if ('maxAwakeTabs' in changed || 'sleepAfterMin' in changed || 'keepPinnedAwake' in changed) memsaver?.kick();
  if ('workspaces' in changed) rememberClosed(prev);
  if ('workspaces' in changed || 'activeWorkspaceId' in changed) reconcile();
  else applyLayout();
}

// ---- Fullscreen (HTML5 video etc.) -----------------------------------------------------------
function setFullscreen(tabId: string, on: boolean) {
  if (!win) return;
  if (on) {
    if (runtime.fullscreenTabId === tabId) return;
    runtime.fullscreenTabId = tabId;
    closeOverlay();
    win.setFullScreen(true);
  } else {
    if (runtime.fullscreenTabId !== tabId) return;
    runtime.fullscreenTabId = null;
    if (win.isFullScreen()) win.setFullScreen(false);
  }
  runtimeChanged();
  reconcile();
}
function exitPageFullscreen() {
  const id = runtime.fullscreenTabId;
  const wc = id ? tabs.webContentsOf(id) : null;
  if (wc) wc.executeJavaScript('document.fullscreenElement && document.exitFullscreen()', true).catch(() => {});
  else if (id) setFullscreen(id, false);
}

// ---- Overlay view ----------------------------------------------------------------------------
let ovSpec: OverlaySpec | null = null;
let ovSeq = 0;
let ovRect: Rect | null = null;
let ovAttached = false;
let lastBlurClose = { kind: '', at: 0 };
/** The overlay has drawn the current spec and been shown (overlayReady ran for it). */
let ovShown = false;
/** Ctrl+F: give the find box the keyboard as soon as the HUD is up. */
let focusFindPending = false;

function createOverlay() {
  if (overlay || !win) return;
  overlay = new WebContentsView({ webPreferences: uiPrefs() });
  overlay.setBackgroundColor('#00000000');
  guardUi(overlay.webContents);
  overlay.webContents.on('did-finish-load', () => (overlayLoaded = true));
  // Popups close when the overlay loses focus (click on the page or elsewhere), like native menus.
  overlay.webContents.on('blur', () => {
    if (!ovSpec || !BLUR_KINDS.includes(ovSpec.kind)) return;
    lastBlurClose = { kind: ovSpec.kind, at: Date.now() };
    closeOverlay();
  });
  overlay.webContents.on('before-input-event', (e, input) => handleKeys(e, input, null, 'overlay'));
  loadUi(overlay.webContents, '#overlay');
}

function openOverlay(spec: OverlaySpec) {
  if (!win || runtime.fullscreenTabId) return;
  createOverlay();
  // A click on the menu button while its menu is open: the blur already closed it, don't reopen.
  if (lastBlurClose.kind === spec.kind && Date.now() - lastBlurClose.at < 300 && !HOVER_KINDS.includes(spec.kind)) return;
  // Suggestion list updates (every keystroke) and HUD updates redraw in place: no hide/re-show, same seq.
  if ((spec.kind === 'suggest' || spec.kind === 'hud') && ovSpec?.kind === spec.kind && ovAttached) {
    ovSpec = spec;
    runtime.overlay = spec;
    runtimeChanged();
    const { width, height } = win.getContentBounds();
    overlay!.webContents.send(CH.overlay, { spec, seq: ovSeq, win: { width, height } });
    return;
  }
  ovSpec = spec;
  ovSeq++;
  ovRect = null;
  ovShown = false;
  runtime.overlay = spec;
  runtimeChanged();
  const ov = overlay!;
  // Draw hidden at full window size; the overlay measures itself and calls overlayReady.
  ov.setVisible(false);
  if (!ovAttached) win.contentView.addChildView(ov);
  ovAttached = true;
  placeEdge();
  const { width, height } = win.getContentBounds();
  ov.setBounds({ x: 0, y: 0, width, height });
  ov.webContents.send(CH.overlay, { spec, seq: ovSeq, win: { width, height } });
}

function overlayReady(seq: number, rect: Rect | null) {
  if (!win || !overlay || !ovSpec || seq !== ovSeq) return;
  const { width, height } = win.getContentBounds();
  ovRect = rect
    ? { x: Math.max(0, rect.x), y: Math.max(0, rect.y), width: Math.min(width, rect.width), height: Math.min(height, rect.height) }
    : null;
  overlay.setBounds(ovRect ?? { x: 0, y: 0, width, height });
  overlay.setVisible(true);
  ovShown = true;
  const hud = ovSpec.kind === 'hud';
  // The HUD never takes the keyboard on its own (a zoom badge must not steal typing from the page).
  const wantsFocus = (!hud && !HOVER_KINDS.includes(ovSpec.kind)) || (ovSpec.kind === 'addressbar' && ovSpec.focus) || (hud && focusFindPending);
  if (hud && focusFindPending) {
    focusFindPending = false;
    sendEvent({ type: 'focus-find' });
  }
  if (wantsFocus && !overlay.webContents.isFocused()) overlay.webContents.focus();
}

function closeOverlay(seq?: number) {
  if (seq !== undefined && seq !== ovSeq) return;
  if (!ovSpec && !ovAttached) return;
  const hadFocus = overlay?.webContents.isFocused();
  ovSpec = null;
  ovRect = null;
  ovShown = false;
  focusFindPending = false;
  runtime.overlay = null;
  runtimeChanged();
  if (overlay && win && ovAttached) {
    overlay.setVisible(false);
    win.contentView.removeChildView(overlay);
    ovAttached = false;
    overlay.webContents.send(CH.overlay, { spec: null, seq: ++ovSeq, win: win.getContentBounds() });
    placeEdge();
  }
  if (hadFocus) {
    const p = activeWorkspace()?.primaryTabId;
    const wc = p ? tabs.webContentsOf(p) : null;
    (wc ?? base?.webContents)?.focus();
  }
  // Whatever the HUD was showing (find bar, prompt...) comes back once the popup is gone.
  setImmediate(syncHud);
}

// ---- HUD: find bar, zoom badge, permission prompt, toast -------------------------------------
// One overlay surface (see OverlaySpec 'hud') drawn from runtime.hud, in the page area's top-right.
function setHud(patch: Partial<HudState>) {
  runtime.hud = { ...runtime.hud, ...patch };
  runtimeChanged();
  syncHud();
}
function hudActive(h = runtime.hud) {
  return !!(h.find || h.zoom || h.toast || h.perm);
}
function hudAnchor(): Rect {
  const li = layoutInput();
  const { primary, secondary } = pageRects(li, animLeft);
  const right = secondary ? secondary.x + secondary.width : primary.x + primary.width;
  return { x: primary.x, y: primary.y, width: right - primary.x, height: primary.height };
}
function syncHud() {
  if (!win || runtime.fullscreenTabId) return;
  if (hudActive()) {
    // Another popup (menu, address bar...) has the overlay: the HUD returns when it closes.
    if (ovSpec && ovSpec.kind !== 'hud') return;
    const a = hudAnchor();
    const cur = ovSpec as Extract<OverlaySpec, { kind: 'hud' }> | null;
    if (!cur || !ovAttached || cur.anchor.x !== a.x || cur.anchor.y !== a.y || cur.anchor.width !== a.width) openOverlay({ kind: 'hud', anchor: a });
    else if (focusFindPending && ovShown) {
      focusFindPending = false;
      overlay?.webContents.focus();
      sendEvent({ type: 'focus-find' });
    }
  } else if (ovSpec?.kind === 'hud') closeOverlay();
}
let toastSeq = 0;
let toastTimer: NodeJS.Timeout | null = null;
function toast(text: string, downloadId?: string) {
  if (toastTimer) clearTimeout(toastTimer);
  setHud({ toast: { id: ++toastSeq, text, downloadId } });
  toastTimer = setTimeout(() => {
    toastTimer = null;
    setHud({ toast: null });
  }, 5000);
}

// ---- Find in page ----------------------------------------------------------------------------
function openFind(): boolean {
  const id = activePageId();
  const t = id ? activeWorkspace()?.tabs.find((x) => x.id === id) : null;
  if (!id || !t || (t.type !== 'web' && t.type !== 'jivvy')) return false;
  const cur = runtime.hud.find;
  if (cur && cur.tabId !== id) closeFind(false);
  focusFindPending = true;
  if (!runtime.hud.find) setHud({ find: { text: '', active: 0, total: 0, tabId: id } });
  else syncHud();
  return true;
}
function closeFind(refocus = true) {
  const f = runtime.hud.find;
  if (!f) return;
  tabs.webContentsOf(f.tabId)?.stopFindInPage('clearSelection');
  focusFindPending = false;
  setHud({ find: null });
  if (refocus) {
    const wc = tabs.webContentsOf(f.tabId);
    if (wc && !ovSpec) wc.focus();
  }
}
/** Search for `text` in the page the find bar belongs to; `next` steps to the following match. */
function findText(text: string, opts: { forward?: boolean; next?: boolean } = {}) {
  const f = runtime.hud.find;
  const wc = f ? tabs.webContentsOf(f.tabId) : null;
  if (!f || !wc) return;
  if (!text) {
    wc.stopFindInPage('clearSelection');
    setHud({ find: { ...f, text: '', active: 0, total: 0 } });
    return;
  }
  setHud({ find: { ...f, text } });
  wc.findInPage(text, { forward: opts.forward !== false, findNext: !!opts.next, matchCase: false });
}
function foundInPage(tabId: string, r: Electron.Result) {
  const f = runtime.hud.find;
  if (!f || f.tabId !== tabId) return;
  // Results arrive as the search runs; only the numbers that came with matches are worth showing.
  const total = r.matches ?? f.total;
  const active = r.activeMatchOrdinal ?? f.active;
  if (total === f.total && active === f.active) return;
  setHud({ find: { ...f, total, active: total === 0 ? 0 : active } });
}

// ---- Zoom (per site, saved by host) ----------------------------------------------------------
function hostKey(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}
let zoomSeq = 0;
let zoomTimer: NodeJS.Timeout | null = null;
function showZoom(percent: number, host: string) {
  if (zoomTimer) clearTimeout(zoomTimer);
  setHud({ zoom: { percent, host, seq: ++zoomSeq } });
  zoomTimer = setTimeout(() => {
    zoomTimer = null;
    setHud({ zoom: null });
  }, 1800);
}
function setZoom(tabId: string, percent: number | 'step-in' | 'step-out' | 'reset') {
  const wc = tabs.webContentsOf(tabId);
  const host = wc ? hostKey(wc.getURL()) : '';
  if (!wc || !host) return;
  const cur = percentFor(wc.getZoomLevel());
  const next = percent === 'reset' ? 100 : percent === 'step-in' ? stepZoom(cur, 1) : percent === 'step-out' ? stepZoom(cur, -1) : percent;
  wc.setZoomLevel(levelFor(next));
  store.dispatch({ type: 'setSiteZoom', host, percent: next });
  showZoom(next, host);
}
/** A page finished navigating: put it at its site's saved zoom (100% when none). */
function applyZoom(wc: WebContents) {
  const host = hostKey(wc.getURL());
  const want = levelFor(store.state.siteZoom[host] ?? 100);
  if (host && Math.abs(wc.getZoomLevel() - want) > 1e-6) wc.setZoomLevel(want);
}

// ---- Closed tabs (Ctrl+Shift+T) --------------------------------------------------------------
interface ClosedTab {
  type: 'web' | 'jivvy';
  title: string;
  pinned: boolean;
  rec: NonNullable<ReturnType<TabManager['snapshot']>>;
}
const closedStack: ClosedTab[] = [];
const MAX_CLOSED = 20;
/** Tabs that just left the state: remember their page + back/forward list (before their view is destroyed). */
function rememberClosed(prev: PersistedState) {
  const now = new Set(store.state.workspaces.flatMap((w) => w.tabs.map((t) => t.id)));
  for (const w of prev.workspaces)
    for (const t of w.tabs) {
      if (now.has(t.id) || (t.type !== 'web' && t.type !== 'jivvy') || !t.url) continue;
      const rec = tabs.snapshot(t.id, t.url, t.title);
      if (!rec) continue;
      closedStack.push({ type: t.type, title: t.title, pinned: !!t.pinned, rec });
      if (closedStack.length > MAX_CLOSED) closedStack.shift();
    }
}
function reopenClosedTab(): boolean {
  const c = closedStack.pop();
  if (!c) return false;
  const id = `tab_${crypto.randomUUID().slice(0, 8)}`;
  tabs.stash(id, c.rec);
  store.dispatch({ type: 'openTab', tab: { id, title: c.title, type: c.type, url: c.rec.url, ...(c.pinned ? { pinned: true } : {}) } });
  return true;
}

// ---- Keyboard shortcuts ----------------------------------------------------------------------
function activePageId(): string | null {
  const p = activeWorkspace()?.primaryTabId;
  return p && tabs.live.has(p) ? p : null;
}
/** Tab shortcuts are skipped while a full-window modal has the screen. */
const MODAL_KINDS: OverlaySpec['kind'][] = ['confirm', 'omnibox', 'settings', 'import'];
function focusAddress() {
  base?.webContents.focus();
  sendEvent({ type: 'focus-address' });
}
/** Switch to the n-th tab (1-based) or by `delta` from the current one, wrapping around. */
function switchTab(pick: { nth: number } | { delta: number }) {
  const ws = activeWorkspace();
  if (!ws || !ws.tabs.length) return;
  const n = ws.tabs.length;
  let i: number;
  if ('nth' in pick) i = pick.nth >= 9 ? n - 1 : Math.min(n - 1, pick.nth - 1);
  else i = (Math.max(0, ws.tabs.findIndex((t) => t.id === ws.primaryTabId)) + pick.delta + n) % n;
  store.dispatch({ type: 'focusTab', tabId: ws.tabs[i].id });
}

/**
 * Browser shortcuts, from any view (pages, base, overlay), so they work whatever has focus.
 * Handled keys are swallowed (preventDefault) so a page or the UI never sees them twice.
 * Ctrl+C/V/X/A/Z and everything not listed go through to whoever has focus.
 */
function handleKeys(e: Electron.Event, input: Input, tabId: string | null, source: 'page' | 'base' | 'overlay') {
  if (input.type !== 'keyDown') return;
  const k = input.key.toLowerCase();
  if (k === 'escape') {
    if (runtime.fullscreenTabId) {
      e.preventDefault();
      exitPageFullscreen();
    } else if (runtime.hud.find && (!ovSpec || ovSpec.kind === 'hud')) closeFind();
    return;
  }
  if (k === 'f11') {
    e.preventDefault();
    if (win && !runtime.fullscreenTabId) win.setFullScreen(!win.isFullScreen());
    return;
  }
  if (ovSpec && MODAL_KINDS.includes(ovSpec.kind)) return;
  const mod = (input.control || input.meta) && !input.alt;
  const alt = input.alt && !input.control && !input.meta;
  const shift = input.shift;
  const page = tabId ?? activePageId();
  const wc = page ? tabs.webContentsOf(page) : null;
  const swallow = () => e.preventDefault();

  if (mod) {
    if (!shift && (k === 'k' || k === 't')) {
      swallow();
      openOverlay({ kind: 'omnibox' });
    } else if (shift && k === 't') {
      swallow();
      reopenClosedTab();
    } else if (!shift && k === 'w') {
      swallow();
      const ws = activeWorkspace();
      const t = ws?.tabs.find((x) => x.id === ws.primaryTabId);
      if (t && t.type !== 'dashboard') store.dispatch({ type: 'closeTab', tabId: t.id });
    } else if (k === 'tab' || k === 'pagedown' || k === 'pageup') {
      swallow();
      switchTab({ delta: (k === 'pageup' || (k === 'tab' && shift)) ? -1 : 1 });
    } else if (!shift && /^[1-9]$/.test(k)) {
      swallow();
      switchTab({ nth: Number(k) });
    } else if (!shift && k === 'l') {
      swallow();
      focusAddress();
    } else if (k === 'r') {
      swallow(); // never reload the UI views
      if (page) {
        if (shift && wc) wc.reloadIgnoringCache();
        else tabs.nav(page, 'reload');
      }
    } else if (!shift && k === 'd') {
      swallow();
      const ws = activeWorkspace();
      const t = ws?.tabs.find((x) => x.id === ws.primaryTabId);
      if (t && t.type !== 'dashboard') store.dispatch({ type: 'togglePin', tabId: t.id });
    } else if (!shift && k === 'f') {
      if (openFind()) swallow();
    } else if (!shift && k === 'j') {
      swallow();
      openOverlay({ kind: 'downloads', anchor: downloadsAnchor() });
    } else if (page && wc && (k === '=' || k === '+' || k === '-' || k === '_' || k === '0') && hostKey(wc.getURL())) {
      swallow();
      setZoom(page, k === '0' ? 'reset' : k === '-' || k === '_' ? 'step-out' : 'step-in');
    } else if (shift && k === 'i' && source !== 'page' && (DEV_URL || process.env.JIVVY_DEVTOOLS === '1')) {
      swallow();
      (source === 'overlay' ? overlay : base)?.webContents.openDevTools({ mode: 'detach' });
    } else if (shift && k === 'i' && wc) {
      swallow();
      wc.openDevTools({ mode: 'detach' });
    }
    return;
  }
  if (alt && page) {
    if (k === 'arrowleft' || k === 'arrowright') {
      swallow();
      tabs.nav(page, k === 'arrowleft' ? 'back' : 'forward');
    } else if (k === 'd') {
      swallow();
      focusAddress();
    }
    return;
  }
  if (k === 'f5') {
    swallow();
    if (page) tabs.nav(page, 'reload');
  }
}

/** Where the downloads panel sits: right-aligned under the address bar position. */
function downloadsAnchor(): Rect {
  const li = layoutInput();
  const r = addressBarRect(li);
  return { x: li.width - 8, y: r.y + r.height, width: 0, height: 0 };
}

function sendEvent(ev: UiEvent, except?: WebContents) {
  for (const wc of uiContents()) if (wc !== except) wc.send(CH.event, ev);
}

// ---- Page context menu ------------------------------------------------------------------------
/** Google / Claude URLs through the same router and bangs the address bar uses. */
function routeUrl(route: 'search' | 'claude', text: string): string {
  const t = text.replace(/\s+/g, ' ').trim().slice(0, 500);
  return decide(`${route === 'search' ? '!s' : '!ask'} ${t}`)?.url ?? `https://www.google.com/search?q=${encodeURIComponent(t)}`;
}
/** View page source: a small separate window (tabs only load http(s)), same session so cookies/cache apply. */
function viewSource(wc: WebContents) {
  const url = wc.getURL();
  if (!/^https?:/i.test(url)) return;
  const w = new BrowserWindow({
    width: 900,
    height: 700,
    parent: win ?? undefined,
    autoHideMenuBar: true,
    title: `Source: ${hostKey(url)}`,
    backgroundColor: '#ffffff',
    webPreferences: { session: pageSession, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
  });
  w.setMenu(null);
  w.webContents.on('will-navigate', (ev) => ev.preventDefault());
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.loadURL(`view-source:${url}`).catch((err) => log('view-source failed', String(err).slice(0, 120)));
}
const menuDeps: MenuDeps = {
  openTab: (url, opts) => {
    if (!isAllowedTabUrl(url)) return;
    let title = url;
    try {
      title = new URL(url).hostname.replace(/^www\./, '');
    } catch {
      /* keep url */
    }
    store.dispatch({ type: 'openTab', tab: { id: `tab_${crypto.randomUUID().slice(0, 8)}`, title, type: 'web', url }, ...(opts.pane ? { targetPane: opts.pane } : {}), background: opts.background });
  },
  routeUrl,
  saveImage: (wc, url) => void downloads.saveAs(wc, url),
  viewSource,
};

// ---- Page hardening: navigation, new windows, popups ---------------------------------------
/** OAuth/SSO popups (window.open with a size) keep `window.opener`; everything else is a tab. */
function looksLikePopup(features: string, disposition: string) {
  return disposition === 'new-window' && /(^|,)\s*(width|height|popup)\s*=/i.test(features);
}
function featureSize(features: string, key: string, def: number) {
  const m = new RegExp(`(?:^|,)\\s*${key}\\s*=\\s*(\\d+)`, 'i').exec(features);
  return m ? Math.min(1600, Math.max(320, Number(m[1]))) : def;
}
function guardPage(wc: WebContents) {
  const block = (e: Electron.Event, url: string) => {
    if (!isAllowedTabUrl(url)) {
      e.preventDefault();
      log('blocked navigation to', url.slice(0, 60));
    }
  };
  wc.on('will-navigate', block);
  wc.on('will-redirect', block);
  wc.setWindowOpenHandler(({ url, disposition, features }) => {
    if (!isAllowedTabUrl(url)) return { action: 'deny' };
    if (looksLikePopup(features, disposition) && win) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: featureSize(features, 'width', 520),
          height: featureSize(features, 'height', 640),
          parent: win,
          autoHideMenuBar: true,
          backgroundColor: '#ffffff',
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
        },
      };
    }
    openTabFromPage(url, disposition === 'background-tab');
    return { action: 'deny' };
  });
  wc.on('did-create-window', (child) => {
    child.setMenu(null);
    guardPage(child.webContents);
  });
}

function openTabFromPage(url: string, background: boolean) {
  let title = url;
  try {
    title = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    /* keep url */
  }
  store.dispatch({ type: 'openTab', tab: { id: `tab_${crypto.randomUUID().slice(0, 8)}`, title, type: 'web', url }, background });
}

// ---- UI views --------------------------------------------------------------------------------
function uiPrefs(): Electron.WebPreferences {
  return {
    preload: path.join(__dirname, 'preload.js'),
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webSecurity: true,
    spellcheck: false,
  };
}
function loadUi(wc: WebContents, hash: string) {
  const url = DEV_URL ? `${DEV_URL}/${hash}` : `app://jivvy/index.html${hash}`;
  wc.loadURL(url).catch((e) => log('UI load failed', String(e)));
}
function guardUi(wc: WebContents) {
  wc.on('will-navigate', (e) => e.preventDefault());
  wc.on('will-redirect', (e) => e.preventDefault());
  wc.setWindowOpenHandler(({ url }) => {
    if (isAllowedTabUrl(url) && url !== 'about:blank') openTabFromPage(url, false);
    return { action: 'deny' };
  });
}

function isFromUi(e: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const ok = uiContents().includes(e.sender);
  const frame = e.senderFrame;
  return ok && !!frame && frame.parent === null && frame.url.startsWith(UI_ORIGIN);
}

// ---- IPC: every message is checked for sender and argument types ---------------------------
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e6;
const isRect = (r: unknown): r is Rect =>
  !!r && typeof r === 'object' && ['x', 'y', 'width', 'height'].every((k) => num((r as Record<string, unknown>)[k]));
const shortStr = (v: unknown, max = 500): v is string => typeof v === 'string' && v.length <= max;

function validSpec(s: unknown): OverlaySpec | null {
  if (!s || typeof s !== 'object') return null;
  const o = s as Record<string, unknown>;
  switch (o.kind) {
    case 'omnibox':
    case 'settings':
    case 'import':
      return { kind: o.kind };
    case 'menu':
      return isRect(o.anchor) && (o.placement === 'up' || o.placement === 'down') ? { kind: 'menu', anchor: o.anchor, placement: o.placement } : null;
    case 'tabmenu':
      return shortStr(o.tabId, 128) && num(o.x) && num(o.y) ? { kind: 'tabmenu', tabId: o.tabId, x: o.x as number, y: o.y as number } : null;
    case 'confirm': {
      const a = validateAction(o.action);
      if (!a || INTERNAL_ACTIONS.has(a.type) || !shortStr(o.title) || !shortStr(o.body, 2000) || !shortStr(o.confirmLabel)) return null;
      return { kind: 'confirm', title: o.title, body: o.body, confirmLabel: o.confirmLabel, action: a };
    }
    case 'rail':
      return isRect(o.anchor) ? { kind: 'rail', anchor: o.anchor } : null;
    case 'zenbar':
      return isRect(o.anchor) && (o.position === 'top' || o.position === 'bottom') ? { kind: 'zenbar', position: o.position, anchor: o.anchor } : null;
    case 'addressbar':
      return isRect(o.anchor) ? { kind: 'addressbar', anchor: o.anchor, focus: o.focus === true } : null;
    case 'downloads':
      return isRect(o.anchor) ? { kind: 'downloads', anchor: o.anchor } : null;
    case 'hud':
      return isRect(o.anchor) ? { kind: 'hud', anchor: o.anchor } : null;
    case 'suggest': {
      if (!isRect(o.anchor) || !Array.isArray(o.items) || o.items.length > 8 || !Number.isInteger(o.selected)) return null;
      const items: SuggestItem[] = [];
      for (const it of o.items as Array<Record<string, unknown>>) {
        if (!it || typeof it.url !== 'string' || it.url.length > 2048 || !shortStr(it.title, 300) || !shortStr(it.host, 253)) return null;
        items.push({ url: it.url, title: it.title, host: it.host });
      }
      return { kind: 'suggest', anchor: o.anchor, items, selected: o.selected as number };
    }
    default:
      return null;
  }
}

async function command(cmd: string, args: Record<string, unknown>): Promise<unknown> {
  switch (cmd) {
    case 'laya_classify':
    case 'laya_health':
      return null; // laya/NPU is disabled on this branch (Phase 2)
    case 'blocking_status':
      return { ready: blocker.ready, rules: blocker.rules, enabled: blocker.enabled };
    case 'memory_status': {
      const m = readProcMeminfo();
      const total = app.getAppMetrics().reduce((n, p) => n + p.memory.workingSetSize, 0) / 1024;
      return {
        totalMB: Math.round(total),
        awake: tabs.live.size,
        sleeping: Object.values(runtime.tabs).filter((t) => t.sleeping).length,
        availableMB: m ? Math.round(m.availableMB) : null,
      };
    }
    case 'sleep_tab':
      if (!shortStr(args.tabId, 128) || !args.tabId) throw new Error('Bad tab');
      return memsaver.sleepOne(args.tabId, true);
    case 'wake_tab': {
      if (!shortStr(args.tabId, 128) || !args.tabId) throw new Error('Bad tab');
      const t = store.state.workspaces.flatMap((w) => w.tabs).find((x) => x.id === args.tabId);
      if (!t?.url || !isPageTab(t)) return false;
      tabs.wake(t.id, t.url);
      return true;
    }
    case 'sleep_background':
      return memsaver.sleepAllBackground();
    case 'free_memory':
      if (typeof args.targetMB !== 'number' || !(args.targetMB > 0) || args.targetMB > 1_000_000) throw new Error('Bad target');
      return memsaver.freeMemory(args.targetMB);
    case 'find':
      if (!shortStr(args.text, 500)) throw new Error('Bad text');
      findText(args.text, { forward: args.forward !== false, next: args.next === true });
      return null;
    case 'find_close':
      closeFind();
      return null;
    case 'zoom_reset': {
      const id = activePageId();
      if (id) setZoom(id, 'reset');
      return null;
    }
    case 'download_cancel':
      if (!shortStr(args.id, 32)) throw new Error('Bad id');
      downloads.cancel(args.id);
      return null;
    case 'download_open':
      if (!shortStr(args.id, 32)) throw new Error('Bad id');
      return downloads.open(args.id);
    case 'download_show':
      if (!shortStr(args.id, 32)) throw new Error('Bad id');
      return downloads.show(args.id);
    case 'downloads_clear':
      downloads.clear();
      return null;
    case 'permission_answer':
      if (!Number.isInteger(args.id) || typeof args.allow !== 'boolean' || typeof args.remember !== 'boolean') throw new Error('Bad answer');
      return perms.answer(args.id as number, args.allow, args.remember);
    case 'toast_dismiss':
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = null;
      setHud({ toast: null });
      return null;
    case 'set_blocking':
      return null; // Electron reads blocking settings from its own state
    case 'read_brief':
      return readBrief();
    case 'open_path':
      if (!shortStr(args.path, 4096) || !args.path) throw new Error('Bad path');
      return openPath(args.path).then(() => null);
    case 'logins_for':
      return shortStr(args.origin, 2048) ? logins.loginsFor(args.origin) : [];
    case 'fill_login': {
      if (!shortStr(args.label, 140) || !shortStr(args.username, 512) || !args.username) throw new Error('Bad arguments');
      const m = /^pane_(.+)$/.exec(args.label);
      if (!m) throw new Error('Bad pane');
      await logins.fillLogin(m[1], args.username);
      return null;
    }
    case 'import_firefox_cookies':
      return logins.importFirefoxCookies();
    case 'import_passwords_csv':
      if (typeof args.csv !== 'string' || args.csv.length > 20 * 1024 * 1024) throw new Error('Bad CSV');
      return logins.importPasswordsCsv(args.csv);
    case 'forget_all_logins':
      return logins.forgetAll();
    case 'migrate_tauri': {
      // Settings button: re-run the import; merging again never duplicates or overwrites.
      const oldDir = defaultTauriDir();
      if (!fs.existsSync(oldDir)) throw new Error('No data from the old Jivvy (WebKit) version found on this machine.');
      if (migrating) throw new Error('Import already running');
      migrating = true;
      try {
        const ud = app.getPath('userData');
        return await runMigration({
          userData: ud,
          oldDir,
          session: () => pageSession,
          logins,
          state: { get: () => store.state, apply: (next) => void store.dispatch({ type: 'applyMigration', patch: next }) },
        });
      } finally {
        migrating = false;
      }
    }
    case 'take_migrated_dash':
      return takeMigratedDash(app.getPath('userData'));
    default:
      throw new Error(`Unknown command ${cmd.slice(0, 40)}`);
  }
}

function registerIpc() {
  ipcMain.handle(CH.init, (e) => (isFromUi(e) ? { state: store.state, runtime } : null));
  ipcMain.on(CH.dispatch, (e, raw) => {
    if (!isFromUi(e)) return;
    const a = validateAction(raw);
    if (!a || INTERNAL_ACTIONS.has(a.type)) return log('rejected action', String((raw as { type?: unknown })?.type).slice(0, 40));
    store.dispatch(a);
  });
  ipcMain.on(CH.tabNav, (e, tabId, action) => {
    if (!isFromUi(e) || !shortStr(tabId, 128) || !['back', 'forward', 'reload', 'stop'].includes(action)) return;
    tabs.nav(tabId, action as NavAction);
  });
  // ---- Local browsing history (validated; UI views only) ----
  ipcMain.on(CH.historyTyped, (e, i) => {
    if (!isFromUi(e) || !i || typeof i !== 'object') return;
    const { text, url, shownUrl, accepted } = i as Record<string, unknown>;
    if (!shortStr(text, 500) || typeof accepted !== 'boolean') return;
    if (typeof url !== 'string' || url.length > 2048 || (shownUrl !== undefined && shownUrl !== null && (typeof shownUrl !== 'string' || shownUrl.length > 2048))) return;
    history.typed({ text, url, shownUrl: (shownUrl as string | null | undefined) || undefined, accepted });
  });
  ipcMain.handle(CH.historySearch, (e, text, limit) => {
    if (!isFromUi(e) || typeof text !== 'string' || text.length > 200 || !(limit === undefined || (Number.isInteger(limit) && limit >= 1))) return [];
    return history.search(text, Math.min(20, (limit as number | undefined) ?? 8));
  });
  ipcMain.handle(CH.historyRecent, (e, limit) => {
    if (!isFromUi(e) || !(limit === undefined || (Number.isInteger(limit) && limit >= 1))) return [];
    return history.recent(Math.min(200, (limit as number | undefined) ?? 20));
  });
  ipcMain.handle(CH.historyClear, (e, range) => {
    if (!isFromUi(e) || !(range === 'hour' || range === 'day' || range === 'all')) return 0;
    const n = history.clear(range);
    void trainer.train(); // predictions.json must not keep sites the user just erased
    return n;
  });
  ipcMain.handle(CH.historyImportFirefox, async (e) => {
    if (!isFromUi(e)) return { state: 'error', imported: 0, skipped: 0, error: 'Rejected' };
    // One heavy job at a time: a click while an import or a retrain runs is ignored.
    if (history.isImporting) return history.importStatus();
    if (trainer.busy) return { state: 'error', imported: 0, skipped: 0, error: 'Busy retraining, try again in a moment' } satisfies ImportStatus;
    const st = await history.importFirefox();
    if (st.state === 'done') void trainer.train(true);
    return st;
  });
  ipcMain.handle(CH.authGoogle, async (e) => {
    if (!isFromUi(e)) throw new Error('Rejected');
    return googleSignIn();
  });
  ipcMain.handle(CH.predictions, (e) => (isFromUi(e) ? trainer.snapshot : null));
  ipcMain.handle(CH.predictionsTrain, (e) => {
    if (!isFromUi(e)) return null;
    if (history.isImporting) return trainer.snapshot; // retrain follows the import automatically
    return trainer.train(true); // joins a run already in flight
  });
  ipcMain.handle(CH.predictionsBench, (e) => (isFromUi(e) && !history.isImporting ? trainer.bench() : null));
  ipcMain.handle(CH.predictionsEvalLog, (e) => (isFromUi(e) ? trainer.readLog() : []));
  ipcMain.handle(CH.historyImportStatus, (e) => (isFromUi(e) ? history.importStatus() : { state: 'idle', imported: 0, skipped: 0 }));
  ipcMain.on(CH.setMuted, (e, tabId, muted) => {
    if (isFromUi(e) && shortStr(tabId, 128) && typeof muted === 'boolean') tabs.setMuted(tabId, muted);
  });
  ipcMain.on(CH.overlayOpen, (e, raw) => {
    const spec = isFromUi(e) ? validSpec(raw) : null;
    if (spec) openOverlay(spec);
  });
  ipcMain.on(CH.overlayClose, (e, seq) => {
    if (isFromUi(e) && (seq === undefined || seq === null || num(seq))) closeOverlay(seq ?? undefined);
  });
  ipcMain.on(CH.overlayReady, (e, seq, rect) => {
    if (!isFromUi(e) || e.sender !== overlay?.webContents || !num(seq) || !(rect === null || isRect(rect))) return;
    overlayReady(seq, rect);
  });
  ipcMain.on(CH.emit, (e, ev) => {
    if (!isFromUi(e) || !ev || typeof ev !== 'object') return;
    if (ev.type === 'edit-folder' && shortStr(ev.id, 128)) sendEvent({ type: 'edit-folder', id: ev.id }, e.sender);
    else if (ev.type === 'edge-hover') {
      if (e.sender === edge?.webContents && (!ovAttached || ovSpec?.kind === 'hud')) openFloatingAddressBar(false);
    } else if (ev.type === 'focus-address') sendEvent({ type: 'focus-address' }, e.sender);
    else if (ev.type === 'suggest-pick' && Number.isInteger(ev.index) && ev.index >= 0 && ev.index < 8) sendEvent({ type: 'suggest-pick', index: ev.index }, e.sender);
  });
  ipcMain.handle(CH.invoke, async (e, cmd, rawArgs) => {
    if (!isFromUi(e) || !shortStr(cmd, 64)) return { ok: false, error: 'Rejected' };
    if (rawArgs !== undefined && (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs))) return { ok: false, error: 'Rejected' };
    try {
      return { ok: true, value: await command(cmd, (rawArgs ?? {}) as Record<string, unknown>) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

// ---- Sessions --------------------------------------------------------------------------------
function cleanUserAgent(ua: string) {
  return ua.replace(/\s(Electron|jivvy-life|Jivvy Life)\/\S+/gi, '');
}

function setupUiSession() {
  const ses = session.defaultSession;
  protocol.handle('app', async (req) => {
    const u = new URL(req.url);
    if (u.host !== 'jivvy') return new Response('Not found', { status: 404 });
    const rel = decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname);
    const file = path.resolve(RENDERER_DIR, `.${rel}`);
    if (!file.startsWith(RENDERER_DIR + path.sep)) return new Response('Forbidden', { status: 403 });
    const res = await net.fetch(pathToFileURL(file).toString()).catch(() => null);
    if (!res || !res.ok) return new Response('Not found', { status: 404 });
    const headers = new Headers(res.headers);
    headers.set('Content-Security-Policy', CSP);
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(res.body, { status: 200, headers });
  });
  if (DEV_URL) {
    ses.webRequest.onHeadersReceived({ urls: [`${DEV_URL}/*`] }, (d, cb) => {
      cb({ responseHeaders: { ...d.responseHeaders, 'Content-Security-Policy': [DEV_CSP] } });
    });
  }
  // The UI needs nothing powerful; allow writing to the clipboard only.
  ses.setPermissionRequestHandler((_wc, p, cb) => cb(p === 'clipboard-sanitized-write'));
  ses.setPermissionCheckHandler((_wc, p) => p === 'clipboard-sanitized-write');
}

function setupPageSession() {
  pageSession = session.fromPartition('persist:jivvy');
  pageSession.setUserAgent(cleanUserAgent(pageSession.getUserAgent()));
  perms.attach(pageSession); // request + check handlers, devices denied
  downloads.attach(pageSession);
  // Spellcheck (red squiggles + suggestions in the context menu). On Linux Chromium fetches the
  // en-US dictionary the first time it is needed.
  pageSession.setSpellCheckerLanguages(['en-US']);
  pageSession.setSpellCheckerEnabled(true);
  blocker.configure(store.state.blockingEnabled, store.state.blockingDisabledSites);
  blocker.attach(pageSession);
  blocker.onReady = () => {
    runtime.blocking = { ready: true, rules: blocker.rules };
    runtimeChanged();
  };
  void blocker.load(path.join(__dirname, 'blocklist-domains.json'));
}

// ---- Window ----------------------------------------------------------------------------------
function createWindow() {
  const icon = [path.join(app.getAppPath(), 'assets', 'icons', '128x128.png'), path.join(__dirname, '..', 'assets', 'icons', '128x128.png')].find((p) => fs.existsSync(p));
  win = new BaseWindow({
    width: 1440,
    height: 900,
    minWidth: 480,
    minHeight: 320,
    title: 'Jivvy Life',
    backgroundColor: '#09090b',
    show: false,
    ...(icon ? { icon } : {}),
  });
  base = new WebContentsView({ webPreferences: uiPrefs() });
  base.setBackgroundColor('#09090b');
  guardUi(base.webContents);
  win.contentView.addChildView(base);
  base.webContents.on('before-input-event', (e, input) => handleKeys(e, input, null, 'base'));
  base.webContents.once('did-finish-load', () => {
    win?.show();
    // The overlay view is created after first paint so the first menu opens instantly.
    setTimeout(createOverlay, 300);
  });
  base.webContents.on('render-process-gone', (_e, d) => {
    log('UI renderer gone:', d.reason);
    if (d.reason !== 'clean-exit') loadUi(base!.webContents, '');
  });
  loadUi(base.webContents, '');

  win.on('resize', applyLayout);
  win.on('leave-full-screen', () => {
    if (runtime.fullscreenTabId) exitPageFullscreen();
  });
  win.on('closed', () => {
    win = null;
    base = null;
    overlay = null;
    edge = null;
    edgeAttached = false;
  });
  reconcile();
}

function logGpuOnce() {
  let logged = false;
  const logFinal = () => {
    if (logged) return;
    logged = true;
    const s = app.getGPUFeatureStatus() as unknown as Record<string, string>;
    const d = screen.getPrimaryDisplay();
    log(
      'gpu',
      JSON.stringify({ gpu_compositing: s.gpu_compositing, rasterization: s.rasterization, video_decode: s.video_decode, opengl: s.opengl, vulkan: s.vulkan }),
      `display scale ${d.scaleFactor}, ozone ${app.commandLine.getSwitchValue('ozone-platform') || app.commandLine.getSwitchValue('ozone-platform-hint') || 'default'}`
    );
  };
  app.once('gpu-info-update', () => setTimeout(logFinal, 500));
  setTimeout(logFinal, 5000);
}

// ---- App lifecycle ---------------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.on('web-contents-created', (_e, wc) => {
    wc.on('will-attach-webview', (ev) => ev.preventDefault());
  });
  app.whenReady().then(async () => {
    if (process.env.JIVVY_MIGRATE_DRYRUN === '1') {
      // Parse the old Tauri data and print counts only (no values, no URLs); changes nothing anywhere.
      try {
        console.log('MIGRATE-DRYRUN', JSON.stringify(await dryRun(defaultTauriDir())));
      } catch (e) {
        console.log('MIGRATE-DRYRUN failed:', String((e as Error).message).slice(0, 120));
      }
      app.exit(0);
      return;
    }
    log('electron', process.versions.electron, 'chrome', process.versions.chrome, 'userData', app.getPath('userData'));
    app.userAgentFallback = cleanUserAgent(app.userAgentFallback);
    Menu.setApplicationMenu(null);
    if (process.env.JIVVY_LAGMON === '1') startLagMon();
    // One-time move from the old Tauri build: before the state loads (it rewrites the state file).
    if (!SELFTEST && !SNAPSHOT) {
      const ud = app.getPath('userData');
      startupMigration = await autoMigrate({
        userData: ud,
        oldDir: defaultTauriDir(),
        session: () => session.fromPartition('persist:jivvy'),
        logins: new Logins({ userData: ud, session: () => session.fromPartition('persist:jivvy'), webContentsOf: () => null }),
        state: fileStateIO(ud),
      });
    }
    store = new StateStore(app.getPath('userData'));
    store.onChange(onStoreChange);
    history = new HistoryStore(app.getPath('userData'), () => store.state.saveHistory);
    trainer = new Trainer(app.getPath('userData'), history, (snap) => {
      for (const wc of uiContents()) wc.send(CH.predictionsUpdated, snap);
    });
    history.onImportStatus((st) => {
      for (const wc of uiContents()) wc.send(CH.historyImportStatus, st);
    });
    trainer.load();
    // The self-test trains on demand against its scratch profile; no background schedule there.
    if (!SELFTEST && !SNAPSHOT) trainer.start();
    logins = new Logins({ userData: app.getPath('userData'), session: () => pageSession, webContentsOf: (id) => tabs.webContentsOf(id) });
    setupUiSession();
    downloads = new Downloads(
      runtime,
      { runtimeChanged, toast, window: () => win },
      process.env.JIVVY_DOWNLOAD_DIR || (SELFTEST || SNAPSHOT ? path.join(app.getPath('userData'), 'downloads') : app.getPath('downloads'))
    );
    perms = new Permissions({
      state: () => store.state,
      remember: (origin, kind, value) => store.dispatch({ type: 'setSitePermission', origin, permission: kind, value }),
      show: (prompt) => setHud({ perm: prompt }),
    });
    setupPageSession();
    tabs = new TabManager(
      {
        session: pageSession,
        blocker,
        history,
        window: () => win!,
        dispatch: (a: Action) => store.dispatch(a),
        runtimeChanged,
        openTabFromPage,
        setFullscreen,
        handleKeys: (e, input, tabId) => handleKeys(e, input, tabId, 'page'),
        guardPage,
        state: () => store.state,
        contextMenu: (_id, wc, params) => buildPageMenu(menuDeps, wc, params).popup({ window: win ?? undefined }),
        foundInPage,
        zoomChanged: (id, dir) => setZoom(id, dir === 'in' ? 'step-in' : 'step-out'),
        applyZoom,
      },
      runtime
    );
    memsaver = new MemorySaver({
      tabs,
      runtime,
      state: () => store.state,
      tabMB: (id) => {
        const wc = tabs.webContentsOf(id);
        const pid = wc?.getOSProcessId();
        const m = pid ? app.getAppMetrics().find((p) => p.pid === pid) : undefined;
        return m ? m.memory.workingSetSize / 1024 : 150;
      },
    });
    memsaver.auto = !SELFTEST && !SNAPSHOT;
    memsaver.start();
    registerIpc();
    logGpuOnce();
    createWindow();
    if (startupMigration) {
      const text = summaryText(startupMigration);
      setTimeout(() => toast(text), 2500); // once: the marker stops it from running again
    }
    if (SELFTEST || SNAPSHOT) {
      void runSelfTest({
        app,
        win: () => win!,
        base: () => base!,
        overlay: () => overlay,
        edge: () => (edgeAttached ? edge : null),
        overlayAttached: () => ovAttached,
        overlayRect: () => ovRect,
        store,
        tabs,
        memsaver,
        runtime,
        blocker,
        history,
        trainer,
        downloads,
        perms,
        menuDeps,
        layoutInput,
        snapshotOnly: SNAPSHOT && !SELFTEST,
      });
    }
  });
  app.on('before-quit', () => {
    store?.flushSync();
    memsaver?.stop();
    perms?.stop();
    trainer?.stop();
    history?.close();
  });
  app.on('window-all-closed', () => app.quit());
}
