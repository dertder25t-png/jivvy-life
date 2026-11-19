// Web tabs: one WebContentsView per tab, owned by main, in the `persist:jivvy` session.
// Inactive tabs are removed from the window but stay alive (background audio keeps playing).
// A tab can also be discarded (webContents destroyed, record kept) to save memory; it is
// recreated from the record when shown again.
import { WebContentsView, type BaseWindow, type Input, type Session, type WebContents, type WebPreferences } from 'electron';
import { isAllowedTabUrl, type Action, type PersistedState } from '../shared/state';
import type { NavAction, RuntimeState, TabRuntime } from '../shared/ipc';
import type { Rect } from '../shared/layout';
import { hostOf, type Blocker } from './blocker';
import type { HistoryStore } from './history';

const log = (...a: unknown[]) => console.error('[tabs]', ...a);

export interface TabHost {
  session: Session;
  blocker: Blocker;
  history: HistoryStore;
  window(): BaseWindow;
  dispatch(a: Action): void;
  runtimeChanged(): void;
  openTabFromPage(url: string, background: boolean): void;
  setFullscreen(tabId: string, on: boolean): void;
  handleKeys(e: Electron.Event, input: Input, tabId: string): void;
  /** Apply nav guards and new-window rules to any page webContents (tabs and popups). */
  guardPage(wc: WebContents): void;
  /** Current persisted state (pinned flags, prefs). */
  state(): PersistedState;
}

export interface LiveTab {
  id: string;
  view: WebContentsView;
  /** Last URL we loaded or the page reported. A different URL in state means "navigate". */
  knownUrl: string;
  attached: boolean;
  bounds: string;
  restoreScroll?: number;
  /** When it last was (or stopped being) in front; LRU order for the memory saver. */
  lastUsed: number;
  /** When the current load started, for the "loading < 10 s" never-sleep rule. */
  loadingSince: number;
}

export interface NavEntry {
  url: string;
  title: string;
  pageState?: string;
}

interface TabRecord {
  url: string;
  title: string;
  favicon: string | null;
  scrollY: number;
  entries: NavEntry[];
  index: number;
}

/** Page background shown while a woken tab loads, so it doesn't flash white (theme zinc-950). */
export const THEME_BG = '#09090b';
const FAVICON_MAX = 64 * 1024;

/** Page-side check for unsaved input. Dispatches a synthetic beforeunload to see if a handler wants to block. */
const DIRTY_JS = `(() => {
  try {
    for (const el of document.querySelectorAll('input,textarea,[contenteditable]')) {
      if (el.matches('[contenteditable]')) {
        if (el.isContentEditable && (el.textContent || '').trim()) return true;
        continue;
      }
      if (el instanceof HTMLTextAreaElement) { if (el.value !== el.defaultValue) return true; continue; }
      const t = (el.type || '').toLowerCase();
      if (t === 'hidden' || t === 'submit' || t === 'button' || t === 'reset' || t === 'image' || t === 'file') continue;
      if (t === 'checkbox' || t === 'radio') { if (el.checked !== el.defaultChecked) return true; continue; }
      if (el.value !== el.defaultValue) return true;
    }
    if (typeof window.onbeforeunload === 'function') return true;
    const ev = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(ev);
    if (ev.defaultPrevented || (typeof ev.returnValue === 'string' && ev.returnValue !== '')) return true;
    return false;
  } catch { return false; }
})()`;

const blankRuntime = (): TabRuntime => ({
  loading: false,
  canGoBack: false,
  canGoForward: false,
  audible: false,
  muted: false,
  favicon: null,
  sleeping: false,
});

export class TabManager {
  readonly live = new Map<string, LiveTab>();
  private records = new Map<string, TabRecord>();

  constructor(private host: TabHost, private runtime: RuntimeState) {}

  private prefs(): WebPreferences {
    return {
      session: this.host.session,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      plugins: true, // built-in PDF viewer
      safeDialogs: true,
    };
  }

  private setRt(id: string, patch: Partial<TabRuntime>) {
    const cur = this.runtime.tabs[id] ?? blankRuntime();
    let changed = false;
    for (const k of Object.keys(patch) as Array<keyof TabRuntime>) if (cur[k] !== patch[k]) changed = true;
    if (!changed) return;
    this.runtime.tabs = { ...this.runtime.tabs, [id]: { ...cur, ...patch } };
    this.host.runtimeChanged();
  }

  private navState(id: string, wc: WebContents) {
    if (wc.isDestroyed()) return;
    this.setRt(id, { canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward() });
  }

  /** The live tab for `id`, creating its view (and loading `url`) if needed. A sleeping tab wakes where it left off. */
  ensure(id: string, url: string): LiveTab {
    const have = this.live.get(id);
    if (have) return have;
    const rec = this.records.get(id);
    this.records.delete(id);
    // A sleeping tab whose URL was changed meanwhile (address bar) starts fresh at the new URL.
    const woke = rec && rec.url === url ? rec : undefined;
    const view = new WebContentsView({ webPreferences: this.prefs() });
    view.setBackgroundColor(rec ? THEME_BG : '#ffffff');
    const now = Date.now();
    const lt: LiveTab = { id, view, knownUrl: url, attached: false, bounds: '', restoreScroll: woke?.scrollY, lastUsed: now, loadingSince: now };
    this.live.set(id, lt);
    this.wire(lt);
    if (rec) view.webContents.once('dom-ready', () => view.setBackgroundColor('#ffffff'));
    this.setRt(id, { ...blankRuntime(), favicon: rec?.favicon ?? null, loading: true });
    if (!woke || !this.restoreHistory(lt, woke)) this.load(lt, url);
    return lt;
  }

  /** Bring back the back/forward list of a woken tab. False = not possible, caller loads the URL. */
  private restoreHistory(lt: LiveTab, rec: TabRecord): boolean {
    if (rec.entries.length < 2 || !rec.entries.every((e) => isAllowedTabUrl(e.url))) return false;
    const h = lt.view.webContents.navigationHistory as unknown as { restore?: (o: { index: number; entries: NavEntry[] }) => Promise<void> };
    if (typeof h.restore !== 'function') return false;
    try {
      lt.knownUrl = rec.url;
      h.restore({ index: rec.index, entries: rec.entries }).catch((e: Error) => {
        log('history restore failed', String(e).slice(0, 120));
        this.load(lt, rec.url);
      });
      return true;
    } catch {
      return false;
    }
  }

  load(lt: LiveTab, url: string) {
    lt.knownUrl = url;
    if (!isAllowedTabUrl(url)) {
      log('refusing to load', url.slice(0, 80));
      return;
    }
    lt.view.webContents.loadURL(url).catch((e: Error) => {
      // ERR_ABORTED (-3) just means another navigation replaced this one.
      if (!/ERR_ABORTED|\(-3\)/.test(String(e))) log('load failed', url.slice(0, 120), String(e).slice(0, 160));
    });
  }

  private wire(lt: LiveTab) {
    const { id } = lt;
    const wc = lt.view.webContents;
    this.host.guardPage(wc);
    const syncPage = (url: string, title?: string) => {
      lt.knownUrl = url;
      this.host.dispatch({ type: 'syncTabFromPage', tabId: id, url, title });
    };
    wc.on('did-start-loading', () => {
      if (!this.runtime.tabs[id]?.loading) lt.loadingSince = Date.now();
      this.setRt(id, { loading: true });
    });
    wc.on('did-stop-loading', () => {
      this.setRt(id, { loading: false });
      if (this.recordable()) this.host.history.title(id, wc.getURL(), wc.getTitle());
      this.navState(id, wc);
    });
    wc.on('did-start-navigation', (d) => {
      if (d.isMainFrame && !d.isSameDocument) {
        const h = hostOf(d.url);
        if (h) this.host.blocker.topHost.set(wc.id, h);
      }
    });
    wc.on('did-navigate', (_e, url) => {
      const h = hostOf(url);
      if (h) this.host.blocker.topHost.set(wc.id, h);
      syncPage(url);
      if (this.recordable()) this.host.history.visit(id, url, '', lt.attached);
      this.navState(id, wc);
    });
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (!isMainFrame) return;
      syncPage(url, wc.getTitle());
      if (this.recordable()) this.host.history.visit(id, url, wc.getTitle(), lt.attached, true);
      this.navState(id, wc);
    });
    wc.on('page-title-updated', (_e, title) => {
      syncPage(wc.getURL() || lt.knownUrl, title);
      if (this.recordable()) this.host.history.title(id, wc.getURL() || lt.knownUrl, title);
    });
    wc.on('page-favicon-updated', (_e, icons) => {
      const u = icons.find((x) => /^https?:|^data:image\//.test(x)) ?? null;
      this.setRt(id, { favicon: u });
      if (u && u.startsWith('http')) void this.cacheFavicon(id, u);
    });
    wc.on('audio-state-changed', (e) => this.setRt(id, { audible: !!e.audible }));
    wc.on('enter-html-full-screen', () => this.host.setFullscreen(id, true));
    wc.on('leave-html-full-screen', () => this.host.setFullscreen(id, false));
    wc.on('before-input-event', (e, input) => this.host.handleKeys(e, input, id));
    wc.on('did-finish-load', () => {
      if (lt.restoreScroll) {
        const y = Math.max(0, Math.round(lt.restoreScroll));
        lt.restoreScroll = undefined;
        wc.executeJavaScript(`window.scrollTo(0, ${y})`).catch(() => {});
      }
    });
    wc.on('render-process-gone', (_e, d) => {
      log(`tab ${id} renderer gone (${d.reason}); reloading`);
      this.setRt(id, { loading: false, audible: false });
      if (d.reason !== 'clean-exit' && d.reason !== 'killed') setTimeout(() => !wc.isDestroyed() && wc.reload(), 500);
    });
  }

  /** History is only kept for the normal persistent profile, never for in-memory (private) sessions. */
  private recordable() {
    return this.host.session.isPersistent();
  }

  /** Show or hide a tab's view in the window. Pages go just above the base view (index 1). */
  attach(lt: LiveTab, on: boolean) {
    if (lt.attached === on) return;
    const win = this.host.window();
    if (on) win.contentView.addChildView(lt.view, 1);
    else win.contentView.removeChildView(lt.view);
    lt.attached = on;
    lt.lastUsed = Date.now();
    if (on) this.host.history.foreground(lt.id);
    else this.host.history.background(lt.id);
    if (!on) lt.bounds = '';
  }

  place(lt: LiveTab, r: Rect) {
    const key = `${r.x},${r.y},${r.width},${r.height}`;
    if (key === lt.bounds) return;
    lt.bounds = key;
    lt.view.setBounds(r);
  }

  destroy(id: string) {
    const lt = this.live.get(id);
    this.records.delete(id);
    this.host.history.tabClosed(id);
    if (lt) {
      this.attach(lt, false);
      this.live.delete(id);
      const wc = lt.view.webContents;
      this.host.blocker.topHost.delete(wc.id);
      if (!wc.isDestroyed()) wc.close();
    }
    this.faviconData.delete(id);
    if (id in this.runtime.tabs) {
      const { [id]: _gone, ...rest } = this.runtime.tabs;
      this.runtime.tabs = rest;
      this.host.runtimeChanged();
    }
  }

  /** Fetch a small favicon once and keep it as a data URL, so a sleeping tab can show it without the network. */
  private async cacheFavicon(id: string, url: string) {
    try {
      const res = await this.host.session.fetch(url, { signal: AbortSignal.timeout(4000) });
      const type = res.headers.get('content-type') ?? '';
      if (!res.ok || !/^image\//.test(type)) return;
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length || buf.length > FAVICON_MAX) return;
      this.faviconData.set(id, { src: url, data: `data:${type.split(';')[0]};base64,${buf.toString('base64')}` });
    } catch {
      /* keep the plain URL */
    }
  }
  private faviconData = new Map<string, { src: string; data: string }>();

  /**
   * Why `id` must stay awake right now, or null if it may sleep. `manual` (the user asked)
   * skips only the pinned rule; audio, unsaved input, fullscreen and fresh loads still protect.
   * The page check is capped at 100 ms; a page too busy to answer stays awake.
   */
  async sleepBlocker(id: string, manual = false): Promise<{ reason: string; scrollY: number } | { reason: null; scrollY: number }> {
    const lt = this.live.get(id);
    if (!lt) return { reason: 'not awake', scrollY: 0 };
    const wc = lt.view.webContents;
    if (lt.attached) return { reason: 'active', scrollY: 0 };
    if (this.runtime.fullscreenTabId === id) return { reason: 'fullscreen', scrollY: 0 };
    if (this.runtime.tabs[id]?.audible || (!wc.isDestroyed() && wc.isCurrentlyAudible())) return { reason: 'audio', scrollY: 0 };
    if (!manual && this.host.state().keepPinnedAwake && this.isPinned(id)) return { reason: 'pinned', scrollY: 0 };
    if (this.runtime.tabs[id]?.loading && Date.now() - lt.loadingSince < 10_000) return { reason: 'loading', scrollY: 0 };
    if (wc.isDestroyed()) return { reason: 'destroyed', scrollY: 0 };
    let scrollY = 0;
    try {
      const r = await Promise.race([
        wc.executeJavaScript(`({ y: window.scrollY, dirty: ${DIRTY_JS} })`) as Promise<{ y: number; dirty: boolean }>,
        new Promise<null>((res) => setTimeout(() => res(null), 100)),
      ]);
      if (r === null) return { reason: 'busy', scrollY: 0 };
      if (r.dirty) return { reason: 'unsaved input', scrollY: 0 };
      scrollY = Number(r.y) || 0;
    } catch {
      /* crashed or about:blank-like page: nothing to lose */
    }
    return { reason: null, scrollY };
  }

  private isPinned(id: string) {
    for (const w of this.host.state().workspaces) if (w.tabs.some((t) => t.id === id && t.pinned)) return true;
    return false;
  }

  /**
   * Put a background tab to sleep: destroy its webContents but keep url/title/favicon/scroll and
   * the back/forward list, so `ensure` brings it back where it was. False = it must stay awake.
   */
  async sleep(id: string, opts: { manual?: boolean } = {}): Promise<boolean> {
    const lt = this.live.get(id);
    if (!lt) return false;
    const chk = await this.sleepBlocker(id, opts.manual);
    if (chk.reason) return false;
    if (this.live.get(id) !== lt || lt.attached) return false;
    const wc = lt.view.webContents;
    let entries: NavEntry[] = [];
    let index = 0;
    try {
      const h = wc.navigationHistory;
      entries = h.getAllEntries().map((e) => ({ url: e.url, title: e.title, ...(e.pageState ? { pageState: e.pageState } : {}) }));
      index = h.getActiveIndex();
      if (entries.length > 50) {
        const drop = entries.length - 50;
        entries = entries.slice(drop);
        index = Math.max(0, index - drop);
      }
    } catch {
      entries = [];
    }
    const fav = this.runtime.tabs[id]?.favicon ?? null;
    const cached = this.faviconData.get(id);
    const rec: TabRecord = {
      url: lt.knownUrl,
      title: wc.getTitle(),
      favicon: cached && cached.src === fav ? cached.data : fav,
      scrollY: chk.scrollY,
      entries,
      index,
    };
    this.live.delete(id);
    this.host.blocker.topHost.delete(wc.id);
    if (!wc.isDestroyed()) wc.close();
    this.records.set(id, rec);
    this.host.history.tabClosed(id);
    this.host.history.skipNext(id); // waking this tab later isn't a new visit
    this.setRt(id, { ...blankRuntime(), favicon: rec.favicon, sleeping: true });
    return true;
  }

  /** Bring a sleeping tab back in the background (no-op if awake). */
  wake(id: string, url: string): LiveTab {
    return this.ensure(id, url);
  }

  isSleeping(id: string) {
    return !this.live.has(id) && this.records.has(id);
  }

  nav(id: string, action: NavAction) {
    const wc = this.live.get(id)?.view.webContents;
    if (!wc || wc.isDestroyed()) return;
    const h = wc.navigationHistory;
    if (action === 'back' && h.canGoBack()) h.goBack();
    else if (action === 'forward' && h.canGoForward()) h.goForward();
    else if (action === 'reload') wc.reload();
    else if (action === 'stop') wc.stop();
  }

  setMuted(id: string, muted: boolean) {
    const wc = this.live.get(id)?.view.webContents;
    if (!wc || wc.isDestroyed()) return;
    wc.setAudioMuted(muted);
    this.setRt(id, { muted });
  }

  webContentsOf(id: string): WebContents | null {
    const wc = this.live.get(id)?.view.webContents;
    return wc && !wc.isDestroyed() ? wc : null;
  }

  tabIdOf(wc: WebContents): string | null {
    for (const [id, lt] of this.live) if (lt.view.webContents === wc) return id;
    return null;
  }
}
