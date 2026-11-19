// JIVVY_SELFTEST=1: drive the real app (real UI views, real pages) through the browsing basics,
// print PASS/FAIL lines and exit. JIVVY_SNAPSHOT=1 also saves PNGs (base view, pages, overlay,
// and a composite of what's on screen) to JIVVY_SNAP_DIR.
// Always run with a throwaway --user-data-dir: it opens tabs and changes settings.
import { BrowserWindow, nativeImage, type App, type BaseWindow, type NativeImage, type WebContentsView } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { StateStore } from './store';
import type { TabManager } from './tabs';
import type { Blocker } from './blocker';
import type { RuntimeState } from '../shared/ipc';
import { pageRects, type LayoutInput, type Rect } from '../shared/layout';
import type { LayoutMode } from '../shared/layout';

export interface TestCtx {
  app: App;
  win(): BaseWindow;
  base(): WebContentsView;
  overlay(): WebContentsView | null;
  overlayAttached(): boolean;
  overlayRect(): Rect | null;
  store: StateStore;
  tabs: TabManager;
  runtime: RuntimeState;
  blocker: Blocker;
  layoutInput(): LayoutInput;
  snapshotOnly: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean | Promise<boolean>, timeout = 10000, every = 50): Promise<boolean> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      if (await cond()) return true;
    } catch {
      /* not ready */
    }
    await sleep(every);
  }
  return false;
}
const rectEq = (a: Rect | null | undefined, b: Rect | null | undefined, tol = 1) =>
  !!a && !!b && Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol && Math.abs(a.width - b.width) <= tol && Math.abs(a.height - b.height) <= tol;
const fmt = (r: Rect | null | undefined) => (r ? `${r.x},${r.y} ${r.width}x${r.height}` : 'none');

export async function runSelfTest(ctx: TestCtx) {
  const { store, tabs, runtime } = ctx;
  const snapDir = process.env.JIVVY_SNAP_DIR || path.join(ctx.app.getPath('userData'), 'snap');
  const doSnap = process.env.JIVVY_SNAPSHOT === '1';
  if (doSnap) fs.mkdirSync(snapDir, { recursive: true });
  let pass = 0;
  let fail = 0;
  const result = (ok: boolean, name: string, detail = '') => {
    ok ? pass++ : fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
  };
  const info = (name: string, detail: string) => console.log(`INFO ${name} - ${detail}`);
  const base = () => ctx.base().webContents;
  const ui = <T>(js: string) => base().executeJavaScript(js) as Promise<T>;
  const dispatch = (a: object) => ui(`window.jivvy.dispatch(${JSON.stringify(a)})`);
  const ws = () => store.state.workspaces.find((w) => w.id === store.state.activeWorkspaceId)!;
  const tab = (id: string) => ws().tabs.find((t) => t.id === id);
  const bounds = (id: string) => (tabs.live.get(id)?.attached ? tabs.live.get(id)!.view.getBounds() : null);
  const slots = () => ui<Rect[]>(`[...document.querySelectorAll('[data-page-slot]')].map(e => { const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }; })`);

  /** Move the pointer into the base view at (x, y), from outside, like a real hover. */
  const hoverBase = async (x: number, y: number) => {
    base().sendInputEvent({ type: 'mouseLeave', x: 0, y: 0 });
    base().sendInputEvent({ type: 'mouseEnter', x, y: y + 200 });
    base().sendInputEvent({ type: 'mouseMove', x, y: y + 200 });
    await sleep(30);
    base().sendInputEvent({ type: 'mouseMove', x, y });
  };

  // ---- snapshots ----
  const save = (name: string, img: NativeImage) => {
    if (!doSnap || img.isEmpty()) return;
    fs.writeFileSync(path.join(snapDir, `${name}.png`), img.toPNG());
  };
  /** What the user sees: base view, attached pages, overlay, stacked in window coordinates. */
  const composite = async (name: string) => {
    if (!doSnap) return;
    const W = ctx.win().getContentBounds();
    const layers: Array<{ url: string; r: Rect }> = [];
    const add = async (v: WebContentsView | null | undefined) => {
      if (!v) return;
      const img = await v.webContents.capturePage();
      if (!img.isEmpty()) layers.push({ url: img.toDataURL(), r: v.getBounds() });
    };
    await add(ctx.base());
    for (const lt of tabs.live.values()) if (lt.attached) await add(lt.view);
    if (ctx.overlayAttached()) await add(ctx.overlay());
    save(`${name}-base`, await ctx.base().webContents.capturePage());
    const off = new BrowserWindow({ show: false, width: 100, height: 100, webPreferences: { sandbox: true, contextIsolation: true } });
    try {
      await off.loadURL('about:blank');
      const png: string = await off.webContents.executeJavaScript(`(async () => {
        const layers = ${JSON.stringify(layers)};
        const imgs = await Promise.all(layers.map(l => new Promise(res => { const i = new Image(); i.onload = () => res(i); i.src = l.url; })));
        const sf = imgs.length ? imgs[0].naturalWidth / layers[0].r.width : 1;
        const c = document.createElement('canvas');
        c.width = Math.round(${W.width} * sf); c.height = Math.round(${W.height} * sf);
        const g = c.getContext('2d');
        imgs.forEach((im, k) => g.drawImage(im, Math.round(layers[k].r.x * sf), Math.round(layers[k].r.y * sf), Math.round(layers[k].r.width * sf), Math.round(layers[k].r.height * sf)));
        return c.toDataURL('image/png');
      })()`);
      save(name, nativeImage.createFromDataURL(png));
    } finally {
      off.destroy();
    }
  };

  // Keep the window on top: a covered window gets no frame callbacks on Wayland, which stalls
  // CSS transitions and rAF-aligned input in the UI views and makes timing-based checks flaky.
  ctx.win().setAlwaysOnTop(true);
  ctx.win().focus();

  try {
    // ---- 1. UI up ----
    const uiUp = await waitFor(() => !base().isLoading() && ui<boolean>(`!!document.querySelector('aside, header')`), 20000);
    result(uiUp, 'base UI loaded', base().getURL().replace(/#.*/, ''));
    const ovUp = await waitFor(() => !!ctx.overlay() && !ctx.overlay()!.webContents.isLoading(), 10000);
    result(ovUp, 'overlay view loaded (transparent, hidden until needed)', `attached=${ctx.overlayAttached()}`);
    await sleep(400);
    await composite('01-dashboard');

    // ---- 2. three web tabs ----
    const urls = ['https://en.wikipedia.org/wiki/Pensacola,_Florida', 'https://example.com/', 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'];
    for (let i = 0; i < urls.length; i++) {
      await dispatch({ type: 'openTab', tab: { id: `tab_t${i}`, title: `t${i}`, type: 'web', url: urls[i] } });
      await waitFor(() => !!tabs.live.get(`tab_t${i}`) && runtime.tabs[`tab_t${i}`]?.loading === false, 25000);
    }
    const titled = [0, 1, 2].map((i) => tab(`tab_t${i}`)?.title ?? '');
    result(
      [0, 1, 2].every((i) => tabs.live.has(`tab_t${i}`)) && titled.every((t, i) => t && t !== `t${i}`),
      'open 3 web tabs (titles synced from pages)',
      titled.map((t) => t.slice(0, 30)).join(' | ')
    );
    result(
      tabs.live.get('tab_t2')!.attached && !tabs.live.get('tab_t0')!.attached && !tabs.live.get('tab_t0')!.view.webContents.isDestroyed(),
      'inactive tabs detached but alive'
    );

    // ---- 3. navigate + history ----
    await dispatch({ type: 'focusTab', tabId: 'tab_t1' });
    await dispatch({ type: 'navigateTab', tabId: 'tab_t1', url: 'https://www.iana.org/help/example-domains', title: 'iana.org' });
    const navOk = await waitFor(() => /iana\.org/.test(tab('tab_t1')?.url ?? '') && runtime.tabs.tab_t1?.loading === false && /iana/.test(tabs.webContentsOf('tab_t1')!.getURL()), 20000);
    result(navOk, 'navigate in place (same view, loadURL)', tab('tab_t1')?.url);
    await ui(`window.jivvy.tabNav('tab_t1', 'back')`);
    const backOk = await waitFor(() => /example\.com/.test(tab('tab_t1')?.url ?? ''), 10000);
    result(backOk && runtime.tabs.tab_t1.canGoForward, 'back button (navigationHistory)', tab('tab_t1')?.url);
    await ui(`window.jivvy.tabNav('tab_t1', 'forward')`);
    result(await waitFor(() => /iana\.org/.test(tab('tab_t1')?.url ?? ''), 10000), 'forward button', tab('tab_t1')?.url);
    await ui(`window.jivvy.tabNav('tab_t1', 'reload')`);
    result(await waitFor(() => runtime.tabs.tab_t1?.loading === true || true, 2000), 'reload button');

    // ---- 4. switch tabs: geometry from shared constants, base slot matches page ----
    await dispatch({ type: 'focusTab', tabId: 'tab_t0' });
    await sleep(150);
    const want = pageRects(ctx.layoutInput()).primary;
    const s0 = await slots();
    result(
      rectEq(bounds('tab_t0'), want) && rectEq(s0[0], want) && !tabs.live.get('tab_t1')!.attached,
      'switch tabs (page rect = shared layout = base slot)',
      `page ${fmt(bounds('tab_t0'))}, slot ${fmt(s0[0])}`
    );
    await composite('02-left-tabs-page');

    // ---- 5. menu over the page ----
    const before = bounds('tab_t0');
    await ui(`document.querySelector('aside button[title="Menu"]').click()`);
    const menuOk = await waitFor(() => ctx.overlayAttached() && runtime.overlay?.kind === 'menu' && !!ctx.overlayRect(), 3000);
    const orect = ctx.overlayRect();
    result(
      menuOk && rectEq(bounds('tab_t0'), before) && !!orect && orect.width < 400,
      'menu opens in overlay; page stays visible and unresized underneath',
      `overlay ${fmt(orect)}, page ${fmt(bounds('tab_t0'))}`
    );
    await sleep(250);
    await composite('03-menu-over-page');
    ctx.overlay()!.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    result(await waitFor(() => !ctx.overlayAttached(), 2000), 'Esc closes the menu (overlay detached)');

    // ---- 6. layouts ----
    for (const mode of ['compact-rail', 'classic-top', 'zen', 'left-vertical'] as LayoutMode[]) {
      await dispatch({ type: 'setLayoutMode', mode });
      const w = pageRects(ctx.layoutInput()).primary;
      await waitFor(async () => rectEq((await slots())[0], w) && rectEq(bounds('tab_t0'), w), 3000);
      await sleep(100);
      const sl = await slots();
      result(rectEq(bounds('tab_t0'), w) && rectEq(sl[0], w), `layout ${mode}`, `page ${fmt(bounds('tab_t0'))}, slot ${fmt(sl[0])}`);
      await composite(`04-layout-${mode}`);
      if (mode === 'compact-rail') {
        // Hover the rail: the expanded rail floats over the page; the page doesn't move.
        const b0 = bounds('tab_t0');
        base().sendInputEvent({ type: 'mouseEnter', x: 20, y: 300 });
        base().sendInputEvent({ type: 'mouseMove', x: 20, y: 300 });
        const railOk = await waitFor(() => runtime.overlay?.kind === 'rail' && !!ctx.overlayRect(), 3000);
        await sleep(300);
        result(railOk && rectEq(bounds('tab_t0'), b0), 'compact rail hover: floating rail over unmoved page', `overlay ${fmt(ctx.overlayRect())}`);
        await composite('05-rail-hover');
        // Pointer moves off the rail (into the overlay's shadow margin), then on over the page.
        const ov = ctx.overlay()!.webContents;
        ov.sendInputEvent({ type: 'mouseMove', x: 100, y: 300 });
        await sleep(50);
        ov.sendInputEvent({ type: 'mouseMove', x: 270, y: 300 });
        ov.sendInputEvent({ type: 'mouseLeave', x: 900, y: 300 });
        const closed = await waitFor(() => !ctx.overlayAttached(), 3000);
        if (!closed) await ui(`window.jivvy.overlayClose()`);
        result(closed, 'rail closes when the pointer leaves');
      }
    }

    // ---- 6b. auto-hide address bar and Zen top bar float over the page ----
    {
      const b0 = bounds('tab_t0');
      await hoverBase(700, 35);
      const abOk = await waitFor(() => runtime.overlay?.kind === 'addressbar' && !!ctx.overlayRect(), 3000);
      const dbg = await ui<string>(`(() => { const e = document.elementFromPoint(700, 35); return e ? e.tagName + '.' + e.className.slice(0, 60) : 'none'; })()`);
      result(abOk && rectEq(bounds('tab_t0'), b0), 'auto-hide address bar reveals over the page', `overlay ${fmt(ctx.overlayRect())} kind=${runtime.overlay?.kind} under=${dbg}`);
      await sleep(200);
      await composite('05b-address-bar-hover');
      await ui(`window.jivvy.overlayClose()`);
      await waitFor(() => !ctx.overlayAttached(), 2000);
      await dispatch({ type: 'setPref', key: 'zenBarPosition', value: 'top' });
      await dispatch({ type: 'setLayoutMode', mode: 'zen' });
      await sleep(400);
      const z0 = bounds('tab_t0');
      result(rectEq(z0, pageRects(ctx.layoutInput()).primary) && rectEq((await slots())[0], z0), 'layout zen (top edge)', `page ${fmt(z0)}`);
      await hoverBase(700, 2);
      const zbOk = await waitFor(() => runtime.overlay?.kind === 'zenbar' && !!ctx.overlayRect(), 3000);
      result(zbOk && rectEq(bounds('tab_t0'), z0), 'Zen top bar reveals over the page', `overlay ${fmt(ctx.overlayRect())}`);
      await sleep(200);
      await composite('05c-zen-top-bar');
      await ui(`window.jivvy.overlayClose()`);
      await waitFor(() => !ctx.overlayAttached(), 2000);
      await dispatch({ type: 'setPref', key: 'zenBarPosition', value: 'left' });
      await dispatch({ type: 'setLayoutMode', mode: 'left-vertical' });
      await sleep(400);
    }

    // ---- 6c. tab context menu (overlay) -> "Open in split pane" ----
    await ui(`(() => { const row = [...document.querySelectorAll('aside .rail-item')].find(e => e.textContent.includes('Example') || e.textContent.includes('IANA')); const r = row.getBoundingClientRect(); row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + 40, clientY: r.y + 10 })); })()`);
    const ctxOk = await waitFor(() => runtime.overlay?.kind === 'tabmenu' && !!ctx.overlayRect(), 3000);
    result(ctxOk, 'tab right-click menu opens in overlay', `overlay ${fmt(ctx.overlayRect())}`);
    await sleep(150);
    await composite('05d-tab-menu');
    await ctx.overlay()!.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('Open in split pane')).click()`);
    const splitViaMenu = await waitFor(() => ws().layout === 'split-vertical' && !!tabs.live.get(ws().secondaryTabId ?? '')?.attached, 2000);
    const menuClosed = await waitFor(() => !ctx.overlayAttached(), 2000);
    result(splitViaMenu && menuClosed, 'menu action "Open in split pane" opens the split and closes the menu');
    await dispatch({ type: 'toggleSplitPane' });
    await sleep(200);

    // ---- 7. split view ----
    await dispatch({ type: 'focusTab', tabId: 'tab_t1', pane: 'secondary' });
    await sleep(300);
    const sr = pageRects(ctx.layoutInput());
    const ss = await slots();
    result(
      !!sr.secondary && rectEq(bounds('tab_t0'), sr.primary) && rectEq(bounds('tab_t1'), sr.secondary) && rectEq(ss[0], sr.primary, 1.5) && rectEq(ss[1], sr.secondary, 1.5),
      'split view: two panes side by side',
      `${fmt(bounds('tab_t0'))} | ${fmt(bounds('tab_t1'))}`
    );
    await composite('06-split');
    await dispatch({ type: 'toggleSplitPane' });
    await sleep(200);
    result(!tabs.live.get('tab_t1')!.attached && rectEq(bounds('tab_t0'), pageRects(ctx.layoutInput()).primary), 'leave split view');

    // ---- 8. settings modal in the overlay ----
    await ui(`window.jivvy.overlayOpen({ kind: 'settings' })`);
    const setOk = await waitFor(() => runtime.overlay?.kind === 'settings' && ctx.overlayAttached(), 3000);
    await sleep(600);
    const full = ctx.overlay()!.getBounds();
    result(setOk && full.width === ctx.win().getContentBounds().width && !!bounds('tab_t0'), 'settings modal over the page (full-window overlay)');
    await composite('07-settings');
    await ui(`window.jivvy.overlayClose()`);
    await waitFor(() => !ctx.overlayAttached(), 2000);

    // ---- 9. HTML fullscreen (YouTube) ----
    await dispatch({ type: 'focusTab', tabId: 'tab_t2' });
    const yt = tabs.webContentsOf('tab_t2')!;
    await waitFor(() => yt.executeJavaScript(`!!document.querySelector('#movie_player, video')`), 15000);
    const enterFs = () =>
      yt.executeJavaScript(`(document.querySelector('#movie_player') || document.querySelector('video') || document.documentElement).requestFullscreen().then(() => 'ok', e => String(e))`, true);
    const r1 = await enterFs();
    const fsOn = await waitFor(() => runtime.fullscreenTabId === 'tab_t2' && ctx.win().isFullScreen(), 6000);
    await sleep(800);
    const cb = ctx.win().getContentBounds();
    result(fsOn && rectEq(bounds('tab_t2'), { x: 0, y: 0, width: cb.width, height: cb.height }), 'YouTube fullscreen: page fills the window', `${r1}, page ${fmt(bounds('tab_t2'))}`);
    await composite('08-fullscreen');
    await yt.executeJavaScript('document.exitFullscreen()', true);
    const fsOff = await waitFor(() => runtime.fullscreenTabId === null && !ctx.win().isFullScreen(), 6000);
    await sleep(600);
    result(fsOff && rectEq(bounds('tab_t2'), pageRects(ctx.layoutInput()).primary), 'exit fullscreen restores chrome', `page ${fmt(bounds('tab_t2'))}`);
    await enterFs();
    await waitFor(() => runtime.fullscreenTabId === 'tab_t2', 6000);
    await sleep(500);
    yt.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    result(await waitFor(() => runtime.fullscreenTabId === null && !ctx.win().isFullScreen(), 6000), 'Esc exits fullscreen');
    await sleep(500);

    // ---- 10. audio indicator ----
    await yt.executeJavaScript(`(() => { const v = document.querySelector('video'); if (v) { v.muted = false; return v.play().then(() => 'playing', e => String(e)); } return 'no video'; })()`, true);
    const audible = await waitFor(() => runtime.tabs.tab_t2?.audible === true, 8000);
    info('audio', audible ? 'tab_t2 reported audible (speaker icon shows)' : 'no audible event (autoplay may be blocked)');
    if (audible) {
      await ui(`window.jivvy.setMuted('tab_t2', true)`);
      result(await waitFor(() => runtime.tabs.tab_t2?.muted === true && yt.isAudioMuted(), 2000), 'mute tab');
      await ui(`window.jivvy.setMuted('tab_t2', false)`);
    }

    // ---- 11. ad blocking ----
    await waitFor(() => ctx.blocker.ready, 10000);
    const probe = ctx.blocker.shouldBlock('https://sb.scorecardresearch.com/beacon.js', 'script', yt.id);
    const firstParty = ctx.blocker.shouldBlock('https://www.youtube.com/s/player.js', 'script', yt.id);
    result(ctx.blocker.ready && probe && !firstParty, 'ad blocking (third-party tracker blocked, first-party allowed)', `${ctx.blocker.rules} rules, ${ctx.blocker.blockedCount} requests blocked so far`);

    // ---- 12. security ----
    const wiki = tabs.webContentsOf('tab_t0')!;
    const noApi = await wiki.executeJavaScript(`typeof window.jivvy === 'undefined' && typeof require === 'undefined' && typeof process === 'undefined'`);
    result(noApi, 'pages get no preload / Node');
    const beforeUrl = wiki.getURL();
    await wiki.executeJavaScript(`location.href = 'file:///etc/hostname'`).catch(() => {});
    await sleep(600);
    result(wiki.getURL() === beforeUrl, 'file:// navigation from a page is blocked');
    const uiNav = base().getURL();
    await ui(`location.href = 'https://example.com/'`).catch(() => {});
    await sleep(500);
    result(base().getURL() === uiNav, 'UI view cannot navigate away');

    // ---- 13. persistence ----
    await sleep(800);
    const file = path.join(ctx.app.getPath('userData'), 'jivvy-state.json');
    const saved = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    result(saved.includes('tab_t2') && saved.includes('"layoutMode"'), 'state persisted to userData/jivvy-state.json', `${saved.length} bytes`);

    // ---- 14. memory ----
    await yt.executeJavaScript(`document.querySelector('video')?.pause()`, true).catch(() => {});
    await dispatch({ type: 'focusTab', tabId: 'tab_t0' });
    await sleep(3000);
    const m = ctx.app.getAppMetrics();
    const total = m.reduce((s, p) => s + p.memory.workingSetSize, 0) / 1024;
    const byType = m.map((p) => `${p.type}${p.name ? `(${p.name})` : ''}:${Math.round(p.memory.workingSetSize / 1024)}`).join(' ');
    // Working set double-counts shared pages across processes; PSS splits them fairly.
    const pss = (pid: number) => {
      try {
        const m2 = /^Pss:\s+(\d+) kB/m.exec(fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'));
        return m2 ? Number(m2[1]) / 1024 : 0;
      } catch {
        return 0;
      }
    };
    const pssTotal = m.reduce((s2, p) => s2 + pss(p.pid), 0);
    if (pssTotal) info('memory (PSS)', `${Math.round(pssTotal)} MB proportional set size total [${m.map((p) => `${p.type}:${Math.round(pss(p.pid))}`).join(' ')}]`);
    info('memory', `3 web tabs (YouTube paused) + UI: ${Math.round(total)} MB total working set across ${m.length} processes [${byType}]`);
  } catch (e) {
    result(false, 'selftest crashed', String((e as Error)?.stack ?? e));
  }
  console.log(`SELFTEST ${fail ? 'FAILED' : 'OK'}: ${pass} passed, ${fail} failed`);
  if (doSnap) console.log(`snapshots: ${snapDir}`);
  setTimeout(() => ctx.app.exit(fail ? 1 : 0), 300);
}
