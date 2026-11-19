// Web tabs: one WebContentsView per tab, owned by main, in the `persist:jivvy` session.
// Inactive tabs are removed from the window but stay alive (background audio keeps playing).
// A tab can also be discarded (webContents destroyed, record kept) to save memory; it is
// recreated from the record when shown again.
import { WebContentsView, type BaseWindow, type Input, type Session, type WebContents, type WebPreferences } from 'electron';
import { isAllowedTabUrl, type Action } from '../shared/state';
import type { NavAction, RuntimeState, TabRuntime } from '../shared/ipc';
import type { Rect } from '../shared/layout';
import { hostOf, type Blocker } from './blocker';

const log = (...a: unknown[]) => console.error('[tabs]', ...a);

export interface TabHost {
  session: Session;
  blocker: Blocker;
  window(): BaseWindow;
  dispatch(a: Action): void;
  runtimeChanged(): void;
  openTabFromPage(url: string, background: boolean): void;
  setFullscreen(tabId: string, on: boolean): void;
  handleKeys(e: Electron.Event, input: Input, tabId: string): void;
  /** Apply nav guards and new-window rules to any page webContents (tabs and popups). */
  guardPage(wc: WebContents): void;
}

export interface LiveTab {
  id: string;
  view: WebContentsView;
  /** Last URL we loaded or the page reported. A different URL in state means "navigate". */
  knownUrl: string;
  attached: boolean;
  bounds: string;
  restoreScroll?: number;
}

interface TabRecord {
  url: string;
  title: string;
  favicon: string | null;
  scrollY: number;
}

const blankRuntime = (): TabRuntime => ({
  loading: false,
  canGoBack: false,
  canGoForward: false,
  audible: false,
  muted: false,
  favicon: null,
  discarded: false,
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

  /** The live tab for `id`, creating its view (and loading `url`) if needed. */
  ensure(id: string, url: string): LiveTab {
    const have = this.live.get(id);
    if (have) return have;
    const rec = this.records.get(id);
    this.records.delete(id);
    const view = new WebContentsView({ webPreferences: this.prefs() });
    view.setBackgroundColor('#ffffff');
    const lt: LiveTab = { id, view, knownUrl: url, attached: false, bounds: '', restoreScroll: rec?.scrollY };
    this.live.set(id, lt);
    this.wire(lt);
    this.setRt(id, { ...blankRuntime(), favicon: rec?.favicon ?? null, loading: true });
    this.load(lt, url);
    return lt;
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
    wc.on('did-start-loading', () => this.setRt(id, { loading: true }));
    wc.on('did-stop-loading', () => {
      this.setRt(id, { loading: false });
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
      this.navState(id, wc);
    });
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (!isMainFrame) return;
      syncPage(url, wc.getTitle());
      this.navState(id, wc);
    });
    wc.on('page-title-updated', (_e, title) => syncPage(wc.getURL() || lt.knownUrl, title));
    wc.on('page-favicon-updated', (_e, icons) => this.setRt(id, { favicon: icons.find((u) => /^https?:|^data:image\//.test(u)) ?? null }));
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

  /** Show or hide a tab's view in the window. Pages go just above the base view (index 1). */
  attach(lt: LiveTab, on: boolean) {
    if (lt.attached === on) return;
    const win = this.host.window();
    if (on) win.contentView.addChildView(lt.view, 1);
    else win.contentView.removeChildView(lt.view);
    lt.attached = on;
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
    if (lt) {
      this.attach(lt, false);
      this.live.delete(id);
      const wc = lt.view.webContents;
      this.host.blocker.topHost.delete(wc.id);
      if (!wc.isDestroyed()) wc.close();
    }
    if (id in this.runtime.tabs) {
      const { [id]: _gone, ...rest } = this.runtime.tabs;
      this.runtime.tabs = rest;
      this.host.runtimeChanged();
    }
  }

  /**
   * Memory saver hook (Phase 3 decides when): destroy a hidden tab's webContents but keep its
   * url/title/favicon/scroll so `ensure` can bring it back where it was.
   */
  async discard(id: string) {
    const lt = this.live.get(id);
    if (!lt || lt.attached) return false;
    const wc = lt.view.webContents;
    let scrollY = 0;
    try {
      scrollY = Number(await wc.executeJavaScript('window.scrollY')) || 0;
    } catch {
      /* page busy or crashed: start at the top */
    }
    if (this.live.get(id) !== lt || lt.attached) return false;
    const rec: TabRecord = { url: lt.knownUrl, title: wc.getTitle(), favicon: this.runtime.tabs[id]?.favicon ?? null, scrollY };
    this.live.delete(id);
    this.host.blocker.topHost.delete(wc.id);
    if (!wc.isDestroyed()) wc.close();
    this.records.set(id, rec);
    this.setRt(id, { ...blankRuntime(), favicon: rec.favicon, discarded: true });
    return true;
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
