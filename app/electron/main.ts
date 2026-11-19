// Jivvy Life, Electron main process.
// One BaseWindow holding: the base UI view (full window, app chrome), the web page views
// (WebContentsViews placed by main from shared layout constants) and one transparent overlay
// view for anything that floats over the pages. Main owns all state (see store.ts).
import { app, BaseWindow, WebContentsView, ipcMain, session, Menu, protocol, net, screen, type Input, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents, type Session } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { StateStore } from './store';
import { TabManager } from './tabs';
import { Blocker } from './blocker';
import { runSelfTest } from './selftest';
import { validateAction, INTERNAL_ACTIONS, isAllowedTabUrl, type Action, type PersistedState } from '../shared/state';
import { CH, HOVER_KINDS, BLUR_KINDS, type NavAction, type OverlaySpec, type RuntimeState, type StatePatch, type UiEvent } from '../shared/ipc';
import { LAYOUT, chromeInsets, cubicBezier, pageRects, type Rect } from '../shared/layout';

const log = (...a: unknown[]) => console.error('[jivvy]', ...a);

// ---- Modes & paths ----------------------------------------------------------------------------
const DEV_URL = process.env.JIVVY_DEV_URL?.replace(/\/$/, '') || '';
const SELFTEST = process.env.JIVVY_SELFTEST === '1';
const SNAPSHOT = process.env.JIVVY_SNAPSHOT === '1';
const RENDERER_DIR = path.join(__dirname, '..', 'dist');
const UI_ORIGIN = DEV_URL || 'app://jivvy';

// Separate profile (tests, side-by-side runs): --user-data-dir=PATH or JIVVY_USER_DATA.
const udArg = process.argv.find((a) => a.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length);
const userData = udArg || process.env.JIVVY_USER_DATA;
if (userData) app.setPath('userData', path.resolve(userData));

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

// ---- Permissions for web pages ---------------------------------------------------------------
// Powerful permissions are denied without a prompt. Notifications and camera/mic are allowed only
// for sites the user allowed (no UI for that yet in Phase 1, so: denied).
const DENY = new Set([
  'geolocation',
  'midi',
  'midiSysex',
  'openExternal',
  'hid',
  'serial',
  'usb',
  'idle-detection',
  'display-capture',
  'window-management',
  'speaker-selection',
  'keyboardLock',
  'fileSystem',
  'clipboard-read',
  'storage-access',
  'top-level-storage-access',
  'mediaKeySystem',
]);
const USER_ALLOWABLE = new Set(['notifications', 'media']);
const userAllowed = new Map<string, Set<string>>(); // origin -> permissions (Phase 2 adds UI)
function pagePermission(permission: string, origin: string): boolean {
  if (USER_ALLOWABLE.has(permission)) return !!userAllowed.get(origin)?.has(permission);
  return !DENY.has(permission);
}

// ---- Globals ---------------------------------------------------------------------------------
let win: BaseWindow | null = null;
let base: WebContentsView | null = null;
let overlay: WebContentsView | null = null;
let overlayLoaded = false;
let store: StateStore;
let tabs: TabManager;
let pageSession: Session;
const blocker = new Blocker();
const runtime: RuntimeState = { tabs: {}, fullscreenTabId: null, overlay: null, blocking: { ready: false, rules: 0 } };

// ---- State broadcast (coalesced per tick) ----------------------------------------------------
let pendingPersist: Partial<PersistedState> = {};
let pendingRuntime = false;
let flushQueued = false;
function uiContents(): WebContents[] {
  return [base, overlay].filter((v): v is WebContentsView => !!v && !v.webContents.isDestroyed()).map((v) => v.webContents);
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

  // Focus follows the primary tab, like a browser.
  const primary = ws?.primaryTabId ?? null;
  if (primary !== lastPrimary) {
    lastPrimary = primary;
    if (!ovSpec || HOVER_KINDS.includes(ovSpec.kind)) {
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
  ovSpec = spec;
  ovSeq++;
  ovRect = null;
  runtime.overlay = spec;
  runtimeChanged();
  const ov = overlay!;
  // Draw hidden at full window size; the overlay measures itself and calls overlayReady.
  ov.setVisible(false);
  if (!ovAttached) win.contentView.addChildView(ov);
  ovAttached = true;
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
  const wantsFocus = !HOVER_KINDS.includes(ovSpec.kind) || (ovSpec.kind === 'addressbar' && ovSpec.focus);
  if (wantsFocus && !overlay.webContents.isFocused()) overlay.webContents.focus();
}

function closeOverlay(seq?: number) {
  if (seq !== undefined && seq !== ovSeq) return;
  if (!ovSpec && !ovAttached) return;
  const hadFocus = overlay?.webContents.isFocused();
  ovSpec = null;
  ovRect = null;
  runtime.overlay = null;
  runtimeChanged();
  if (overlay && win && ovAttached) {
    overlay.setVisible(false);
    win.contentView.removeChildView(overlay);
    ovAttached = false;
    overlay.webContents.send(CH.overlay, { spec: null, seq: ++ovSeq, win: win.getContentBounds() });
  }
  if (hadFocus) {
    const p = activeWorkspace()?.primaryTabId;
    const wc = p ? tabs.webContentsOf(p) : null;
    (wc ?? base?.webContents)?.focus();
  }
}

// ---- Keyboard shortcuts ----------------------------------------------------------------------
function activePageId(): string | null {
  const p = activeWorkspace()?.primaryTabId;
  return p && tabs.live.has(p) ? p : null;
}
function handleKeys(e: Electron.Event, input: Input, tabId: string | null, source: 'page' | 'base' | 'overlay') {
  if (input.type !== 'keyDown') return;
  const k = input.key.toLowerCase();
  if (k === 'escape' && runtime.fullscreenTabId) {
    e.preventDefault();
    exitPageFullscreen();
    return;
  }
  const mod = input.control || input.meta;
  const page = tabId ?? activePageId();
  const wc = page ? tabs.webContentsOf(page) : null;
  if (source === 'page') {
    if (mod && !input.shift && (k === 'k' || k === 't')) {
      e.preventDefault();
      openOverlay({ kind: 'omnibox' });
      return;
    }
    if (mod && k === 'l') {
      e.preventDefault();
      base?.webContents.focus();
      sendEvent({ type: 'focus-address' });
      return;
    }
    if (input.alt && (k === 'arrowleft' || k === 'arrowright') && page) {
      e.preventDefault();
      tabs.nav(page, k === 'arrowleft' ? 'back' : 'forward');
      return;
    }
    if (mod && wc && (k === '=' || k === '+' || k === '-' || k === '0')) {
      e.preventDefault();
      wc.setZoomLevel(k === '0' ? 0 : wc.getZoomLevel() + (k === '-' ? -0.5 : 0.5));
      return;
    }
    if (mod && input.shift && k === 'i' && wc) {
      e.preventDefault();
      wc.openDevTools({ mode: 'detach' });
      return;
    }
  }
  if ((mod && k === 'r') || k === 'f5') {
    e.preventDefault(); // never reload the UI views
    if (page) tabs.nav(page, 'reload');
    return;
  }
  if (mod && k === 'w') {
    e.preventDefault();
    const ws = activeWorkspace();
    const t = ws?.tabs.find((x) => x.id === ws.primaryTabId);
    if (t && t.type !== 'dashboard') store.dispatch({ type: 'closeTab', tabId: t.id });
    return;
  }
  if (mod && input.shift && k === 'i' && source !== 'page' && (DEV_URL || process.env.JIVVY_DEVTOOLS === '1')) {
    e.preventDefault();
    (source === 'overlay' ? overlay : base)?.webContents.openDevTools({ mode: 'detach' });
  }
}

function sendEvent(ev: UiEvent, except?: WebContents) {
  for (const wc of uiContents()) if (wc !== except) wc.send(CH.event, ev);
}

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
    default:
      return null;
  }
}

const NOT_YET = 'Not yet available in the Electron build';
async function command(cmd: string): Promise<unknown> {
  switch (cmd) {
    case 'laya_classify':
    case 'laya_health':
      return null; // laya/NPU is disabled on this branch (Phase 2)
    case 'blocking_status':
      return { ready: blocker.ready, rules: blocker.rules, enabled: blocker.enabled };
    case 'install_kind':
      return 'electron';
    case 'set_blocking':
      return null; // Electron reads blocking settings from its own state
    case 'read_brief':
    case 'open_path':
    case 'logins_for':
    case 'fill_login':
    case 'import_firefox_cookies':
    case 'import_passwords_csv':
    case 'forget_all_logins':
      throw new Error(NOT_YET);
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
    else if (ev.type === 'focus-address') sendEvent({ type: 'focus-address' }, e.sender);
  });
  ipcMain.handle(CH.invoke, async (e, cmd, _args) => {
    if (!isFromUi(e) || !shortStr(cmd, 64)) return { ok: false, error: 'Rejected' };
    try {
      return { ok: true, value: await command(cmd) };
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
  pageSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    const origin = (() => {
      try {
        return new URL(details.requestingUrl || wc.getURL()).origin;
      } catch {
        return '';
      }
    })();
    cb(pagePermission(permission, origin));
  });
  pageSession.setPermissionCheckHandler((_wc, permission, origin) => pagePermission(permission, origin));
  pageSession.setDevicePermissionHandler(() => false);
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
  const icon = [path.join(__dirname, '..', 'src-tauri', 'icons', 'icon.png'), path.join(__dirname, 'icon.png')].find((p) => fs.existsSync(p));
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
  app.whenReady().then(() => {
    log('electron', process.versions.electron, 'chrome', process.versions.chrome, 'userData', app.getPath('userData'));
    app.userAgentFallback = cleanUserAgent(app.userAgentFallback);
    Menu.setApplicationMenu(null);
    store = new StateStore(app.getPath('userData'));
    store.onChange(onStoreChange);
    setupUiSession();
    setupPageSession();
    tabs = new TabManager(
      {
        session: pageSession,
        blocker,
        window: () => win!,
        dispatch: (a: Action) => store.dispatch(a),
        runtimeChanged,
        openTabFromPage,
        setFullscreen,
        handleKeys: (e, input, tabId) => handleKeys(e, input, tabId, 'page'),
        guardPage,
      },
      runtime
    );
    registerIpc();
    logGpuOnce();
    createWindow();
    if (SELFTEST || SNAPSHOT) {
      void runSelfTest({
        app,
        win: () => win!,
        base: () => base!,
        overlay: () => overlay,
        overlayAttached: () => ovAttached,
        overlayRect: () => ovRect,
        store,
        tabs,
        runtime,
        blocker,
        layoutInput,
        snapshotOnly: SNAPSHOT && !SELFTEST,
      });
    }
  });
  app.on('before-quit', () => store?.flushSync());
  app.on('window-all-closed', () => app.quit());
}
