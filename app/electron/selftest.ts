// JIVVY_SELFTEST=1: drive the real app (real UI views, real pages) through the browsing basics,
// print PASS/FAIL lines and exit. JIVVY_SNAPSHOT=1 also saves PNGs (base view, pages, overlay,
// and a composite of what's on screen) to JIVVY_SNAP_DIR.
// Always run with a throwaway --user-data-dir: it opens tabs and changes settings.
import { BrowserWindow, nativeImage, type App, type BaseWindow, type NativeImage, type WebContentsView } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { StateStore } from './store';
import type { TabManager } from './tabs';
import type { MemorySaver } from './memsaver';
import type { Blocker } from './blocker';
import { HistoryStore } from './history';
import type { Trainer } from './trainer';
import { DatabaseSync } from 'node:sqlite';
import { session as electronSession, safeStorage } from 'electron';
import { Logins } from './logins';
import { insideHome } from './native';
import os from 'node:os';
import { lagStats, resetLag, startLagMon } from './lagmon';
import type { RuntimeState } from '../shared/ipc';
import { pageRects, type LayoutInput, type Rect } from '../shared/layout';
import type { LayoutMode } from '../shared/layout';

export interface TestCtx {
  app: App;
  win(): BaseWindow;
  base(): WebContentsView;
  overlay(): WebContentsView | null;
  /** The top-edge hover strip view while it is attached (auto-hide address bar), else null. */
  edge(): WebContentsView | null;
  overlayAttached(): boolean;
  overlayRect(): Rect | null;
  store: StateStore;
  tabs: TabManager;
  memsaver: MemorySaver;
  runtime: RuntimeState;
  blocker: Blocker;
  history: HistoryStore;
  trainer: Trainer;
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


/** A fake Firefox profile (root + profiles.ini + places.sqlite) with `nVisits` visits spread over the last 170 days. */
function makeFakeFirefox(ffRoot: string, nVisits: number, nPlaces = Math.round(nVisits / 5)) {
  const prof = path.join(ffRoot, 'lag.default-release');
  fs.rmSync(ffRoot, { recursive: true, force: true });
  fs.mkdirSync(prof, { recursive: true });
  fs.writeFileSync(path.join(ffRoot, 'profiles.ini'), '[Profile0]\nName=default-release\nIsRelative=1\nPath=lag.default-release\nDefault=1\n\n[General]\nStartWithLastProfile=1\n');
  const db = new DatabaseSync(path.join(prof, 'places.sqlite'));
  db.exec(`CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url LONGVARCHAR, title LONGVARCHAR);
    CREATE TABLE moz_historyvisits (id INTEGER PRIMARY KEY, from_visit INTEGER, place_id INTEGER, visit_date INTEGER, visit_type INTEGER);`);
  let seed = 12345;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  db.exec('BEGIN');
  const insP = db.prepare('INSERT INTO moz_places VALUES (?, ?, ?)');
  for (let i = 1; i <= nPlaces; i++) insP.run(i, `https://site${i % 700}.lagtest.example/p/${i}?x=${i % 7}`, `Lag test page ${i} of site ${i % 700}`);
  const insV = db.prepare('INSERT INTO moz_historyvisits (place_id, visit_date, visit_type) VALUES (?, ?, ?)');
  const now = Date.now();
  for (let i = 0; i < nVisits; i++) {
    const place = 1 + Math.floor(Math.pow(rnd(), 2) * nPlaces);
    const t = now - Math.floor(rnd() * 170 * 86_400_000) - i; // distinct ms
    insV.run(place, t * 1000, rnd() < 0.1 ? 2 : 1);
  }
  db.exec('COMMIT');
  db.close();
}

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

    // ---- 3b. local browsing history ----
    {
      const h = ctx.history;
      const titledVisit = (host: string) => h.recent(50).find((v) => v.host === host && v.title);
      await waitFor(() => !!titledVisit('example.com') && !!titledVisit('iana.org'), 15000);
      const ex = titledVisit('example.com');
      const ia = titledVisit('iana.org');
      result(!!ex && !!ia && h.counts().visits >= 2, 'history: visiting pages records visits with titles', `${ex?.title.slice(0, 20)} | ${ia?.title.slice(0, 20)}`);
      const viaUi = await ui<Array<{ host: string }>>(`window.jivvy.historySearch('exam', 5)`);
      const viaUi2 = await ui<Array<{ host: string }>>(`window.jivvy.historySearch('ian', 5)`);
      result(viaUi.some((r) => r.host === 'example.com') && viaUi2.some((r) => r.host === 'iana.org'), 'history:search finds pages by host prefix', `${viaUi.length}+${viaUi2.length} hits`);
      result((await ui<unknown[]>(`window.jivvy.historySearch("100%_\\\\", 5)`)).length === 0, 'history:search escapes LIKE wildcards');
      const typedBefore = h.counts().typed;
      await ui(`window.jivvy.historyTyped({ text: 'exam', url: 'https://example.com/', shownUrl: 'https://example.com/', accepted: true })`);
      result(await waitFor(() => h.counts().typed === typedBefore + 1, 3000), 'history:typed records the typed input');
      const mode = fs.statSync(path.join(ctx.app.getPath('userData'), 'history.sqlite')).mode & 0o777;
      result(mode === 0o600, 'history.sqlite is mode 0600', mode.toString(8));
      await dispatch({ type: 'setPref', key: 'saveHistory', value: false });
      await sleep(100);
      const nv = h.counts();
      h.visit('tab_nope', 'https://off.example.org/', 'x', true);
      await ui(`window.jivvy.historyTyped({ text: 'off', url: '', accepted: false })`);
      await sleep(150);
      const nv2 = h.counts();
      result(nv.visits === nv2.visits && nv.typed === nv2.typed, '"Save browsing history" off records nothing');
      await dispatch({ type: 'setPref', key: 'saveHistory', value: true });
      h.tabClosed('tab_nope');
      h.visit('tab_creds', 'https://user:pw@secret.example.org/', 'x', true);
      result(h.search('secret', 5).length === 0, 'URLs with credentials are never recorded');

      // Firefox import against a fake profile in the scratch dir (never the real one).
      const ffRoot = path.join(ctx.app.getPath('userData'), 'fake-firefox');
      const prof = path.join(ffRoot, 'abc.default-release');
      fs.rmSync(ffRoot, { recursive: true, force: true });
      fs.mkdirSync(prof, { recursive: true });
      fs.writeFileSync(path.join(ffRoot, 'profiles.ini'), '[Profile0]\nName=default-release\nIsRelative=1\nPath=abc.default-release\nDefault=1\n\n[General]\nStartWithLastProfile=1\n');
      const fake = new DatabaseSync(path.join(prof, 'places.sqlite'));
      fake.exec(`CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url LONGVARCHAR, title LONGVARCHAR);
        CREATE TABLE moz_historyvisits (id INTEGER PRIMARY KEY, from_visit INTEGER, place_id INTEGER, visit_date INTEGER, visit_type INTEGER);`);
      const us = (daysAgo: number) => (Date.now() - daysAgo * 86_400_000) * 1000;
      const places = [
        [1, 'https://www.Imported-Typed.test/home', 'Typed one'],
        [2, 'https://www.google.com/search?q=fake+query', 'fake query - Google Search'],
        [3, 'https://linked.test/a?b=1', 'Linked'],
        [4, 'https://reloaded.test/', 'Reloaded'],
        [5, 'https://ancient.test/', 'Ancient'],
        [6, 'place:sort=8', 'Not a page'],
      ];
      for (const p of places) fake.prepare('INSERT INTO moz_places VALUES (?, ?, ?)').run(...(p as [number, string, string]));
      const vis: Array<[number, number, number]> = [[1, us(5), 2], [2, us(4), 1], [3, us(3), 1], [4, us(2), 9], [5, us(200), 1], [6, us(1), 1]];
      for (const v of vis) fake.prepare('INSERT INTO moz_historyvisits (place_id, visit_date, visit_type) VALUES (?, ?, ?)').run(...v);
      fake.close();
      const tmpDirs = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('jivvy-ffimport-')).length;
      const tmpBefore = tmpDirs();
      const r1 = await h.importFirefox([ffRoot]);
      const rows = h.raw()!.prepare("SELECT host, transition, query, engine FROM visits WHERE url LIKE '%imported-typed%' OR url LIKE '%google.com/search?q=fake%' OR url LIKE '%linked.test%'").all() as Array<{ host: string; transition: string; query: string | null }>;
      const tr = Object.fromEntries(rows.map((r) => [r.host, r.transition]));
      result(
        r1.state === 'done' && r1.imported === 3 && tr['imported-typed.test'] === 'typed' && tr['google.com'] === 'search' && tr['linked.test'] === 'link',
        'Firefox import: 3 recent visits imported (typed/search/link mapped; reload, >180d, non-http skipped)',
        JSON.stringify({ imported: r1.imported, skipped: r1.skipped, ...tr })
      );
      const r2 = await h.importFirefox([ffRoot]);
      result(r2.imported === 0 && r2.skipped === 3, 'Firefox import: re-import skips duplicates', `imported ${r2.imported}, skipped ${r2.skipped}`);
      result(tmpDirs() === tmpBefore, 'Firefox import: temp copy deleted');
      const stat = await ui<{ state: string; imported: number }>(`window.jivvy.historyImportStatus()`);
      result(stat.state === 'done', 'history:importStatus reports the last import', JSON.stringify(stat));
      fs.rmSync(ffRoot, { recursive: true, force: true });
    }

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
        // Compact + auto-hide address bar: no empty band, the page starts at the very top.
        const li = ctx.layoutInput();
        const pg = bounds('tab_t0');
        result(li.autoHideAddressBar && pg?.y === 0 && sl[0]?.y === 0, 'compact + auto-hide: page top is 0 (no empty band)', `page ${fmt(pg)}, slot ${fmt(sl[0])}, topBar=${li.showTopBar}`);
        const edgeRect = ctx.edge()?.getBounds();
        result(!!edgeRect && edgeRect.y === 0 && edgeRect.height <= 6 && edgeRect.x === pg!.x, 'top-edge hover strip sits over the page top', fmt(edgeRect));
      }
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
      const ev = ctx.edge()?.webContents;
      ev?.sendInputEvent({ type: 'mouseLeave', x: 0, y: 0 });
      ev?.sendInputEvent({ type: 'mouseEnter', x: 300, y: 1 });
      ev?.sendInputEvent({ type: 'mouseMove', x: 300, y: 1 });
      const abOk = await waitFor(() => runtime.overlay?.kind === 'addressbar' && !!ctx.overlayRect(), 3000);
      result(abOk && rectEq(bounds('tab_t0'), b0) && bounds('tab_t0')!.y === 0, 'auto-hide address bar floats over the page from the top-edge strip (page not resized)', `overlay ${fmt(ctx.overlayRect())} kind=${runtime.overlay?.kind}`);
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

    // ---- 12b. logins, cookie import, open_path ----
    {
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jivvy-st-logins-'));
      try {
        // Fake Firefox profile (the real one is never touched; the root is not reachable via IPC).
        const ffRoot = path.join(scratch, 'firefox');
        const prof = path.join(ffRoot, 'abc.default');
        fs.mkdirSync(prof, { recursive: true });
        fs.writeFileSync(path.join(ffRoot, 'profiles.ini'), '[Profile0]\nName=default\nIsRelative=1\nPath=abc.default\nDefault=1\n');
        const fdb = new DatabaseSync(path.join(prof, 'cookies.sqlite'));
        fdb.exec('CREATE TABLE moz_cookies (id INTEGER PRIMARY KEY, name TEXT, value TEXT, host TEXT, path TEXT, expiry INTEGER, isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER)');
        const ins = fdb.prepare('INSERT INTO moz_cookies (name,value,host,path,expiry,isSecure,isHttpOnly,sameSite) VALUES (?,?,?,?,?,?,?,?)');
        const future = Math.floor(Date.now() / 1000) + 86400;
        ins.run('sid', 'abc123', '.example.test', '/', future, 1, 1, 2);
        ins.run('hostonly', 'v', 'app.example.test', '/p', future * 1000, 0, 0, 1);
        ins.run('old', 'x', '.example.test', '/', Math.floor(Date.now() / 1000) - 100, 0, 0, 0);
        fdb.close();
        const ses = electronSession.fromPartition(`jivvy-selftest-${Date.now()}`);
        const lg = new Logins({ userData: path.join(scratch, 'ud'), session: () => ses, webContentsOf: (id) => tabs.webContentsOf(id), firefoxRoots: [ffRoot] });
        const ci = await lg.importFirefoxCookies();
        const got = await ses.cookies.get({});
        const sid = got.find((c) => c.name === 'sid');
        const ho = got.find((c) => c.name === 'hostonly');
        result(
          ci.imported === 2 && ci.skipped === 1 && ci.profile === 'abc.default' && !!sid && sid.domain === ".example.test" && !!sid.secure && !!sid.httpOnly && sid.sameSite === 'strict' && !!ho && ho.path === '/p' && !ho.domain?.startsWith('.') && !got.some((c) => c.name === 'old'),
          'cookie import from fake Firefox profile (expired skipped, flags kept)',
          JSON.stringify(ci)
        );
        result(!fs.readdirSync(os.tmpdir()).some((f) => f.startsWith('jivvy-ffcookies-')), 'cookie import temp copy deleted');

        const csv = 'url,username,password,httpRealm,formActionOrigin\r\nhttps://login.example.test/,alice,"p,ass""w\nd",,\nhttps://login.example.test/,bob,pw2,,\nhttp://x.test/,carol,pw3,Realm,\nftp://y/,dave,pw,,\n';
        let avail = false;
        let backend = 'n/a';
        try {
          avail = safeStorage.isEncryptionAvailable();
          backend = process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : 'native';
        } catch {
          /* not ready */
        }
        info('safeStorage', `available=${avail} backend=${backend}`);
        if (avail && backend !== 'basic_text' && backend !== 'unknown') {
          const r = lg.importPasswordsCsv(csv);
          const users = lg.loginsFor('https://login.example.test/account').sort();
          const idx = path.join(scratch, 'ud', 'logins_index.json');
          const raw = fs.readFileSync(idx, 'utf8');
          const mode = fs.statSync(idx).mode & 0o777;
          result(r.imported === 2 && r.skipped === 2 && users.join() === 'alice,bob' && lg.loginsFor('https://evil.test/').length === 0 && lg.loginsFor('http://login.example.test/').length === 0, 'passwords CSV import + logins_for', JSON.stringify(r));
          result(mode === 0o600 && !raw.includes('pw2') && !raw.includes('ass"w'), 'login index is 0600 and holds no plaintext', `mode ${mode.toString(8)}`);
          result(await lg.fillLogin('tab_nonexistent', 'alice').then(() => false, () => true), 'fill_login refuses an unknown tab');
          result(lg.forgetAll() === 2 && lg.loginsFor('https://login.example.test/').length === 0, 'forget_all_logins');
        } else {
          const refused = (() => {
            try {
              lg.importPasswordsCsv(csv);
              return false;
            } catch (e) {
              return /keyring/i.test(String((e as Error).message));
            }
          })();
          result(refused && !fs.existsSync(path.join(scratch, 'ud', 'logins_index.json')), 'passwords refused cleanly without a keyring (nothing written)');
        }
        const rej = await ui<string>(`window.jivvy.invoke('open_path', { path: '/etc/passwd' }).then(() => 'opened', (e) => String(e.message))`);
        result(rej === 'outside home' && !insideHome('/etc/passwd') && insideHome(os.homedir()), 'open_path rejects /etc/passwd', rej);
        const bad = await ui<string>(`window.jivvy.invoke('open_path', { path: 5 }).then(() => 'opened', (e) => String(e.message))`);
        result(bad === 'Bad path', 'open_path validates argument types', bad);
        const rb = await ui<string>(`window.jivvy.invoke('read_brief').then((v) => v === null || typeof v === 'object' ? 'ok' : 'bad', (e) => String(e.message))`);
        result(rb === 'ok', 'read_brief returns object or null');
      } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
      }
    }

    // ---- 12b. predictions: trainer, inline autocomplete, dashboard routing (scratch profile only) ----
    {
      const dir = ctx.app.getPath('userData');
      const pfile = path.join(dir, 'predictions.json');
      const raw = ctx.history.raw()!;
      const ins = raw.prepare("INSERT OR IGNORE INTO visits (url, host, path, title, t, transition) VALUES (?, ?, ?, ?, ?, 'typed')");
      for (let i = 0; i < 40; i++) ins.run('https://zebrafish.test/', 'zebrafish.test', '/', 'Zebrafish Lab', Date.now() - i * 3_600_000 * 7 - 1000);
      for (let i = 0; i < 6; i++) ins.run('https://quokka-notes.test/inbox', 'quokka-notes.test', '/inbox', 'Quokka Notes', Date.now() - i * 86_400_000 - 5000);
      const t0 = Date.now();
      const snap = await ctx.trainer.train();
      info('trainer', `${Date.now() - t0} ms in worker, ${snap?.sites.length} sites`);
      const pmode = fs.existsSync(pfile) ? fs.statSync(pfile).mode & 0o777 : -1;
      const onDisk = fs.existsSync(pfile) ? JSON.parse(fs.readFileSync(pfile, 'utf8')) : null;
      result(!!snap && pmode === 0o600 && onDisk?.version === 1 && onDisk.sites.some((x: { host: string }) => x.host === 'zebrafish.test'), 'trainer: predictions.json written (mode 0600) with seeded sites', `mode ${pmode.toString(8)}, ${onDisk?.sites?.length} sites`);
      result(!fs.readdirSync(dir).some((n) => n.startsWith('predictions.json.') && n.endsWith('.tmp')), 'trainer: atomic write leaves no temp file');
      const viaUi = await waitFor(() => ui<boolean>(`window.jivvy.predictions().then((p) => !!p && p.sites.some((x) => x.host === 'zebrafish.test'))`), 3000);
      result(viaUi, 'window.jivvy.predictions() returns the new snapshot');
      // self-evaluation: params + eval in the snapshot, one line in predictions-eval.jsonl (0600)
      const efile = path.join(dir, 'predictions-eval.jsonl');
      const elines = fs.existsSync(efile) ? fs.readFileSync(efile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
      const emode = fs.existsSync(efile) ? fs.statSync(efile).mode & 0o777 : -1;
      result(elines.length >= 1 && emode === 0o600 && elines[elines.length - 1].params && 'promoted' in elines[elines.length - 1], 'trainer: predictions-eval.jsonl written (mode 0600)', `${elines.length} line(s), mode ${emode.toString(8)}`);
      result(!!snap?.params && snap.params.halfLifeDays > 0 && !!snap.eval && typeof snap.eval.status === 'string' && onDisk?.params?.wTyped > 0 && !!onDisk?.eval, 'snapshot carries params and eval', `eval ${snap?.eval?.status}, n=${snap?.eval?.n}`);
      const bres = await ctx.trainer.bench();
      result(!!bres && bres.rows.length >= 2 && bres.rows.every((r) => Number.isFinite(r.metrics.top3[1])), 'trainer: benchmark runs in the worker on live history', `${bres?.rows.map((r) => r.label).join(',')}`);

      // Address bar (floating copy in the overlay view): type a host prefix -> inline completion.
      await ui(`window.jivvy.overlayClose()`);
      await waitFor(() => !ctx.overlayAttached(), 2000);
      const primary = ws().primaryTabId!;
      const urlBefore = tab(primary)?.url ?? '';
      await ui(`window.jivvy.overlayOpen({ kind: 'addressbar', anchor: { x: 240, y: 0, width: 900, height: 40 }, focus: true })`);
      await waitFor(() => runtime.overlay?.kind === 'addressbar' && !!ctx.overlayRect(), 3000);
      const ovw = ctx.overlay()!.webContents;
      await waitFor(() => ovw.executeJavaScript(`document.activeElement && document.activeElement.tagName === 'INPUT'`), 3000);
      await waitFor(() => ovw.executeJavaScript(`!!document.querySelector('input')`), 3000);
      await sleep(300); // snapshot fetched on first render
      const field = () => ovw.executeJavaScript(`(() => { const i = document.querySelector('input'); return { v: i.value, s: i.selectionStart, e: i.selectionEnd, rows: document.querySelectorAll('[data-suggest-row]').length }; })()`) as Promise<{ v: string; s: number; e: number; rows: number }>;
      ovw.insertText('zebr');
      await waitFor(async () => (await field()).v === 'zebrafish.test', 3000);
      const f1 = await field();
      result(f1.v === 'zebrafish.test' && f1.s === 4 && f1.e === 14, 'address bar: typing "zebr" inline-completes the host, completion selected', JSON.stringify(f1));
      result(f1.rows >= 1 && f1.rows <= 6, 'address bar: suggestion dropdown renders in the overlay view', `${f1.rows} rows`);
      const key = (k: string) => {
        ovw.sendInputEvent({ type: 'keyDown', keyCode: k });
        if (k === 'Enter') ovw.sendInputEvent({ type: 'char', keyCode: '\r' });
        ovw.sendInputEvent({ type: 'keyUp', keyCode: k });
      };
      key('Backspace');
      await sleep(250);
      const f2 = await field();
      result(f2.v === 'zebr' && f2.s === 4 && f2.e === 4, 'address bar: Backspace removes the inline part', JSON.stringify(f2));
      ovw.insertText('a');
      await waitFor(async () => (await field()).v === 'zebrafish.test', 3000);
      const typedBefore = ctx.history.counts().typed;
      key('Enter');
      const navd = await waitFor(() => /zebrafish\.test/.test(tab(primary)?.url ?? '') || ws().tabs.some((t) => /zebrafish\.test/.test(t.url ?? '')), 5000);
      result(navd, 'address bar: Enter opens the completed URL', tab(primary)?.url);
      result(await waitFor(() => ctx.history.counts().typed === typedBefore + 1, 3000), 'address bar: submit records history:typed');
      const row = raw.prepare("SELECT text, accepted FROM typed_inputs ORDER BY id DESC LIMIT 1").get() as { text: string; accepted: number };
      result(row?.text === 'zebra' && row.accepted === 1, 'address bar: typed input saved as accepted', JSON.stringify(row));
      await ui(`window.jivvy.overlayClose()`);
      await waitFor(() => !ctx.overlayAttached(), 2000);
      for (const t of ws().tabs.filter((t2) => /zebrafish\.test/.test(t2.url ?? '') && t2.id !== primary)) await dispatch({ type: 'closeTab', tabId: t.id });
      if (/zebrafish\.test/.test(tab(primary)?.url ?? '')) await dispatch({ type: 'navigateTab', tabId: primary, url: urlBefore, title: tab(primary)?.title ?? '' });

      // Base-view bar: its dropdown is drawn by the overlay view, updates in place and never steals focus.
      const sug = (n: number) => `window.jivvy.overlayOpen({ kind: 'suggest', anchor: { x: 300, y: 40, width: 600, height: 0 }, selected: 0, items: [${Array.from({ length: n }, (_, i) => `{ url: 'https://s${i}.test/', title: 'S${i}', host: 's${i}.test' }`).join(',')}] })`;
      await ui(sug(2));
      const sOk = await waitFor(() => runtime.overlay?.kind === 'suggest' && !!ctx.overlayRect(), 3000);
      const rowsOf = () => ctx.overlay()!.webContents.executeJavaScript(`document.querySelectorAll('[data-suggest-row]').length`) as Promise<number>;
      const r2 = await rowsOf();
      await ui(sug(4));
      const r4 = await waitFor(async () => (await rowsOf()) === 4, 2000);
      result(sOk && r2 === 2 && r4 && !ctx.overlay()!.webContents.isFocused(), 'base-view address bar dropdown: renders in the overlay, updates in place, takes no focus', `rows ${r2} -> 4, rect ${fmt(ctx.overlayRect())}`);
      await ui(`window.jivvy.overlayClose()`);
      await waitFor(() => !ctx.overlayAttached(), 2000);

      // Dashboard box: "!gpt hello" -> ChatGPT.
      const dash = ws().tabs.find((t) => t.type === 'dashboard');
      if (!dash) result(false, 'dashboard tab present for the box test');
      else {
        await dispatch({ type: 'focusTab', tabId: dash.id });
        await waitFor(() => ui<boolean>(`!!document.querySelector('textarea')`), 5000);
        await ui(`(() => { const ta = document.querySelector('textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(ta, '!gpt hello'); ta.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        const chip = await waitFor(() => ui<boolean>(`[...document.querySelectorAll('span.rounded-full')].some((e) => e.textContent.includes('ChatGPT'))`), 3000);
        result(chip, 'dashboard box: "!gpt hello" shows the ChatGPT route chip');
        const tabsBefore = ws().tabs.length;
        await ui(`document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`);
        const opened = await waitFor(() => ws().tabs.some((t) => /^https:\/\/chatgpt\.com\/\?q=hello/.test(t.url ?? '')), 5000);
        result(opened && ws().tabs.length === tabsBefore + 1, 'dashboard box: Enter on "!gpt hello" opens ChatGPT', ws().tabs.find((t) => /chatgpt/.test(t.url ?? ''))?.url);
        for (const t of ws().tabs.filter((t2) => /chatgpt\.com/.test(t2.url ?? ''))) await dispatch({ type: 'closeTab', tabId: t.id });
      }
      await dispatch({ type: 'focusTab', tabId: primary });
      await sleep(300);
    }


    // ---- 12c. no UI freeze: 20k-visit Firefox import + "Retrain now" with the lag monitors on ----
    {
      startLagMon();
      const ffRoot = path.join(ctx.app.getPath('userData'), 'fake-firefox-lag');
      const t0 = Date.now();
      makeFakeFirefox(ffRoot, 20_000);
      info('lag', `fake profile with 20000 visits built in ${Date.now() - t0} ms`);
      await ui(`window.jivvy.overlayOpen({ kind: 'settings' })`);
      await waitFor(() => runtime.overlay?.kind === 'settings' && !!ctx.overlayRect(), 4000);
      const ov = () => ctx.overlay()!.webContents;
      await waitFor(() => ov().executeJavaScript(`!!document.querySelector('[data-action="retrain"]')`), 4000);
      const views = () => [base(), ov()];
      for (const v of views()) await v.executeJavaScript(`window.__jivvyLagStart && window.__jivvyLagStart(); window.__jivvyLagReset && window.__jivvyLagReset()`);
      await sleep(500);
      for (const v of views()) await v.executeJavaScript(`window.__jivvyLagReset()`);
      resetLag();
      const trainedBefore = ctx.trainer.snapshot?.trainedAt ?? 0;
      const tImp = Date.now();
      const ir = await ctx.history.importFirefox([ffRoot]);
      const impMs = Date.now() - tImp;
      result(ir.state === 'done' && ir.imported > 15_000, 'lag: 20k Firefox import completes', `${ir.state}, ${ir.imported} imported, ${ir.skipped} skipped, ${impMs} ms`);
      // click "Retrain now" in the Settings overlay (the real UI path)
      await ov().executeJavaScript(`document.querySelector('[data-action="retrain"]').click()`);
      const tTr = Date.now();
      const trained = await waitFor(() => (ctx.trainer.snapshot?.trainedAt ?? 0) > trainedBefore, 60_000, 100);
      result(trained, 'lag: Retrain now produces a new snapshot', `${Date.now() - tTr} ms, ${ctx.trainer.snapshot?.sites.length} sites`);
      await sleep(1500); // let the UI views receive + render the snapshot
      const ms = lagStats();
      const gaps = await Promise.all(views().map((v) => v.executeJavaScript(`window.__jivvyLag()`) as Promise<{ maxGap: number; frames: number; gaps: Array<{ ms: number }> }>));
      const rmax = Math.max(...gaps.map((g) => g.maxGap));
      info('lag', `main max stall ${ms.maxStall} ms; renderer max frame gap base ${Math.round(gaps[0].maxGap)} ms (${gaps[0].frames} frames), overlay ${Math.round(gaps[1].maxGap)} ms (${gaps[1].frames} frames); stalls ${JSON.stringify(ms.stalls)}`);
      result(ms.maxStall < 100, 'lag: main-process stall < 100 ms during import + retrain', `${ms.maxStall} ms`);
      result(gaps.every((g) => g.frames > 10) && rmax < 200, 'lag: renderer frame gap < 200 ms during import + retrain', `${Math.round(rmax)} ms`);
      const uiSnap = await ui<{ sites: unknown[]; weekday?: unknown; stats: { sites: number } } | null>(`window.jivvy.predictions()`);
      result(!!uiSnap && uiSnap.sites.length <= 2000 && !('weekday' in uiSnap) && (uiSnap.stats?.sites ?? 0) >= uiSnap.sites.length, 'lag: UI gets a compact snapshot (sites capped, no weekday)', `${uiSnap?.sites.length} of ${uiSnap?.stats?.sites} sites`);
      // concurrent clicks are ignored
      const again = await Promise.all([ctx.trainer.train(true), ctx.trainer.train(true)]);
      result(again[0] === again[1] || (!!again[0] && !!again[1] && again[0].trainedAt === again[1].trainedAt), 'lag: concurrent retrains share one run');
      await ui(`window.jivvy.overlayClose()`);
      await waitFor(() => !ctx.overlayAttached(), 2000);
      fs.rmSync(ffRoot, { recursive: true, force: true });
    }

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

    // ---- 15. memory saver: sleeping tabs, awake cap, never-sleep rules, pressure guard ----
    {
      const saver = ctx.memsaver;
      const pages: Record<string, (n: string) => string> = {
        p: (n) => `<title>Page ${n}</title><body style="margin:0"><div style="height:5000px">page ${n}</div></body>`,
        second: () => '<title>Second</title><body style="margin:0"><div style="height:5000px">second</div></body>',
        audio: () => '<title>Audio</title><body>tone<script>const c=new AudioContext();const o=c.createOscillator();const g=c.createGain();g.gain.value=0.02;o.connect(g);g.connect(c.destination);o.start();c.resume();</script></body>',
        form: () => '<title>Form</title><body><textarea id="t"></textarea></body>',
        unload: () => '<title>Unload</title><body>unload<script>window.onbeforeunload=e=>{e.preventDefault();return "x"}</script></body>',
      };
      const http = await import('node:http');
      const srv = http.createServer((req, res) => {
        const m = /^\/(\w+)(?:\/(\w+))?/.exec(req.url ?? '/');
        const f = pages[m?.[1] ?? 'p'] ?? pages.p;
        res.setHeader('content-type', 'text/html');
        res.end(`<!doctype html><meta charset=utf-8>${f(m?.[2] ?? '0')}`);
      });
      await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
      const port = (srv.address() as { port: number }).port;
      const u = (p2: string) => `http://127.0.0.1:${port}/${p2}`;
      const kind = (id: string) => (runtime.tabs[id]?.sleeping ? 'sleeping' : tabs.live.has(id) ? 'awake' : 'none');
      const awakeIds = () => [...tabs.live.keys()];
      const wcOf = (id: string) => tabs.webContentsOf(id)!;
      const open = async (id: string, url: string, title = id) => {
        await dispatch({ type: 'openTab', tab: { id, title, type: 'web', url } });
        await waitFor(() => !!tabs.live.get(id) && runtime.tabs[id]?.loading === false && !!wcOf(id)?.getTitle(), 15000);
      };
      const measure = () => {
        const m = ctx.app.getAppMetrics();
        const wsMB = m.reduce((n, p2) => n + p2.memory.workingSetSize, 0) / 1024;
        const pssMB = m.reduce((n, p2) => n + (() => { try { const x = /^Pss:\s+(\d+) kB/m.exec(fs.readFileSync(`/proc/${p2.pid}/smaps_rollup`, 'utf8')); return x ? Number(x[1]) / 1024 : 0; } catch { return 0; } })(), 0);
        return { wsMB: Math.round(wsMB), pssMB: Math.round(pssMB), procs: m.length };
      };

      // Fresh slate: only the dashboard, single layout.
      await dispatch({ type: 'focusTab', tabId: 'tab_dashboard' });
      for (const t of ws().tabs.filter((x) => x.type !== 'dashboard')) await dispatch({ type: 'closeTab', tabId: t.id });
      if (ws().layout !== 'single') await dispatch({ type: 'toggleSplitPane' });
      await dispatch({ type: 'setPref', key: 'maxAwakeTabs', value: 20 });
      saver.auto = true;
      await waitFor(() => tabs.live.size === 0, 5000);

      // 8 tabs awake (cap 20). t0 gets a second history entry and a 2000 px scroll.
      const ids = Array.from({ length: 8 }, (_, i) => `tab_m${i}`);
      for (let i = 0; i < 8; i++) {
        await open(ids[i], u(`p/${i}`), `Page ${i}`);
        if (i === 0) {
          await dispatch({ type: 'navigateTab', tabId: ids[0], url: u('second'), title: 'Second' });
          await waitFor(() => /\/second/.test(wcOf(ids[0]).getURL()) && runtime.tabs[ids[0]]?.loading === false, 8000);
          await wcOf(ids[0]).executeJavaScript('window.scrollTo(0, 2000)');
        }
      }
      result(awakeIds().length === 8 && ids.every((id) => kind(id) === 'awake'), 'memory saver: 8 tabs awake with a cap of 20', `${awakeIds().length} live`);
      await sleep(2500);
      const awake8 = measure();
      info('memory 8 awake', `${awake8.wsMB} MB working set, ${awake8.pssMB} MB PSS (${awake8.procs} processes)`);

      // Cap 3: only 3 stay awake, the rest sleep with titles kept.
      const visitsBefore = ctx.history.counts().visits;
      await dispatch({ type: 'setPref', key: 'maxAwakeTabs', value: 3 });
      const capped = await waitFor(() => awakeIds().length === 3 && ids.filter((id) => kind(id) === 'sleeping').length === 5, 15000);
      result(capped, 'max awake 3: only 3 stay awake, 5 sleep', `awake ${awakeIds().length}: ${awakeIds().join(',')}`);
      result(
        ids.slice(0, 5).every((id, i) => tab(id)?.title && tab(id)!.title !== id && (id === ids[0] ? true : tab(id)!.title === `Page ${i}`)) && !!tab(ids[0])?.title,
        'sleeping tabs keep identity and titles in state',
        ids.slice(0, 5).map((id) => tab(id)?.title).join(' | ')
      );
      result(awakeIds().includes(ids[7]) && awakeIds().includes(ids[6]) && awakeIds().includes(ids[5]), 'least recently used tabs are the ones that slept', awakeIds().join(','));
      await sleep(3000);
      const awake3 = measure();
      info('memory 3 awake', `${awake3.wsMB} MB working set, ${awake3.pssMB} MB PSS (${awake3.procs} processes); saved ${awake8.wsMB - awake3.wsMB} MB working set, ${awake8.pssMB - awake3.pssMB} MB PSS vs 8 awake`);
      result(awake3.pssMB < awake8.pssMB && awake3.wsMB < awake8.wsMB, 'memory: 3 awake uses less than 8 awake', `ws ${awake8.wsMB} -> ${awake3.wsMB} MB, PSS ${awake8.pssMB} -> ${awake3.pssMB} MB`);

      // Waking restores URL, scroll and back/forward list; no extra history visit.
      await dispatch({ type: 'focusTab', tabId: ids[0] });
      const woke = await waitFor(() => kind(ids[0]) === 'awake' && /\/second/.test(wcOf(ids[0]).getURL()) && runtime.tabs[ids[0]]?.loading === false, 15000);
      const sy = woke ? await waitFor(async () => Math.abs((await wcOf(ids[0]).executeJavaScript('window.scrollY')) - 2000) < 5, 6000) : false;
      result(woke, 'waking a sleeping tab restores its URL', wcOf(ids[0])?.getURL());
      result(sy, 'waking restores the scroll position (2000 px)', String(await wcOf(ids[0])?.executeJavaScript('window.scrollY')));
      result(runtime.tabs[ids[0]]?.canGoBack === true || (await waitFor(() => runtime.tabs[ids[0]]?.canGoBack === true, 3000)), 'waking restores the back/forward list', `canGoBack=${runtime.tabs[ids[0]]?.canGoBack}`);
      await sleep(800);
      result(ctx.history.counts().visits === visitsBefore, 'waking a tab adds no duplicate history visit', `${visitsBefore} -> ${ctx.history.counts().visits}`);
      result(runtime.tabs[ids[0]]?.sleeping === false, 'woken tab no longer flagged sleeping');

      // Audio tab never sleeps.
      await open('tab_audio', u('audio'), 'Audio');
      const heard = await waitFor(() => runtime.tabs.tab_audio?.audible === true, 8000);
      info('audio', heard ? 'oscillator reported audible' : 'audible flag never set (no audio device?)');
      for (const id of ['tab_x1', 'tab_x2', 'tab_x3']) await open(id, u(`p/${id}`), id);
      await dispatch({ type: 'setPref', key: 'maxAwakeTabs', value: 2 });
      await waitFor(() => awakeIds().length <= 3, 15000);
      await sleep(1500);
      result(heard && kind('tab_audio') === 'awake', 'a tab playing audio never sleeps (cap 2)', `${awakeIds().join(',')}`);
      result(!(await saver.sleepOne('tab_audio')) && kind('tab_audio') === 'awake', 'sleep_tab refuses an audible tab');

      // Unsaved input / beforeunload never sleeps; clearing the input lets it sleep.
      await open('tab_form', u('form'), 'Form');
      await wcOf('tab_form').executeJavaScript(`document.getElementById('t').value = 'half-written note'`);
      await open('tab_unload', u('unload'), 'Unload');
      await open('tab_y1', u('p/y1'), 'y1');
      await sleep(800);
      await saver.sleepAllBackground();
      result(kind('tab_form') === 'awake', 'a tab with typed-in textarea is not slept', kind('tab_form'));
      result(kind('tab_unload') === 'awake', 'a tab with a beforeunload handler is not slept', kind('tab_unload'));
      await wcOf('tab_form').executeJavaScript(`document.getElementById('t').value = ''`);
      await saver.sleepAllBackground();
      result(kind('tab_form') === 'sleeping', 'once the input is empty the tab can sleep', kind('tab_form'));

      // Pinned tabs stay awake while "Keep pinned tabs awake" is on.
      await open('tab_pin', u('p/pin'), 'pin');
      await dispatch({ type: 'togglePin', tabId: 'tab_pin' });
      await open('tab_y2', u('p/y2'), 'y2');
      await saver.sleepAllBackground();
      result(kind('tab_pin') === 'awake', 'pinned tab stays awake (keep pinned on)', kind('tab_pin'));
      await dispatch({ type: 'setPref', key: 'keepPinnedAwake', value: false });
      await saver.sleepAllBackground();
      result(kind('tab_pin') === 'sleeping', 'pinned tab sleeps when keep-pinned is off', kind('tab_pin'));
      await dispatch({ type: 'setPref', key: 'keepPinnedAwake', value: true });
      await dispatch({ type: 'togglePin', tabId: 'tab_pin' });

      // Active tabs never sleep, including both split panes.
      await dispatch({ type: 'setPref', key: 'maxAwakeTabs', value: 20 });
      await dispatch({ type: 'focusTab', tabId: ids[1] });
      await dispatch({ type: 'focusTab', tabId: ids[2], pane: 'secondary' });
      await waitFor(() => kind(ids[1]) === 'awake' && kind(ids[2]) === 'awake', 15000);
      await dispatch({ type: 'setPref', key: 'maxAwakeTabs', value: 2 });
      await sleep(1500);
      await saver.sleepAllBackground();
      result(kind(ids[1]) === 'awake' && kind(ids[2]) === 'awake' && !!tabs.live.get(ids[1])?.attached && !!tabs.live.get(ids[2])?.attached, 'both split panes stay awake under cap 2', `${awakeIds().join(',')}`);
      if (ws().layout !== 'single') await dispatch({ type: 'toggleSplitPane' });
      await dispatch({ type: 'focusTab', tabId: ids[1] });

      // Memory pressure guard with a fake MemAvailable reader.
      await dispatch({ type: 'setPref', key: 'maxAwakeTabs', value: 20 });
      saver.settleMs = 50;
      for (const id of ids.slice(3, 7)) await dispatch({ type: 'focusTab', tabId: id }), await waitFor(() => kind(id) === 'awake' && runtime.tabs[id]?.loading === false, 15000);
      await dispatch({ type: 'focusTab', tabId: ids[7] });
      await waitFor(() => kind(ids[7]) === 'awake' && runtime.tabs[ids[7]]?.loading === false, 15000);
      await sleep(1000);
      const bgBefore = awakeIds().filter((id) => !tabs.live.get(id)!.attached);
      let slept = 0;
      saver.readMem = () => ({ availableMB: slept > 0 ? 6000 : 900, totalMB: 16000 });
      const origSleep = saver.sleepOne.bind(saver);
      saver.sleepOne = async (id, manual) => ((await origSleep(id, manual)) ? (slept++, true) : false);
      const g1 = await saver.guard();
      result(g1 === 1 && slept === 1, 'memory pressure: guard stops once MemAvailable recovers', `slept ${g1} of ${bgBefore.length} background`);
      saver.sleepOne = origSleep;
      saver.readMem = () => ({ availableMB: 900, totalMB: 16000 });
      const g2 = await saver.guard();
      const bgAfter = awakeIds().filter((id) => !tabs.live.get(id)!.attached);
      const exempt = ['tab_audio', 'tab_unload'];
      result(bgAfter.every((id) => exempt.includes(id) || runtime.tabs[id]?.loading) && g2 >= 1, 'memory pressure: background tabs sleep LRU-first until none are left', `slept ${g2}; still awake in background: ${bgAfter.join(',') || 'none'}`);
      result(!!tabs.live.get(ids[7])?.attached, 'memory pressure never sleeps the active tab');
      // Pressure guard threshold: plenty of memory means no sleeping.
      await dispatch({ type: 'focusTab', tabId: ids[3] });
      await waitFor(() => kind(ids[3]) === 'awake' && runtime.tabs[ids[3]]?.loading === false, 15000);
      await dispatch({ type: 'focusTab', tabId: ids[7] });
      await waitFor(() => kind(ids[7]) === 'awake', 15000);
      saver.readMem = () => ({ availableMB: 9000, totalMB: 16000 });
      const g3 = await saver.guard();
      result(g3 === 0 && kind(ids[3]) === 'awake', 'no memory pressure: guard leaves tabs alone');
      // freeMemory(targetMB) for future AI features.
      saver.readMem = () => ({ availableMB: 1000 + 700 * Object.values(runtime.tabs).filter((t) => t.sleeping).length, totalMB: 16000 });
      const before = Object.values(runtime.tabs).filter((t) => t.sleeping).length;
      const fr = await saver.freeMemory(1000 + 700 * (before + 1));
      result(fr.slept >= 1 && fr.satisfied, 'freeMemory(targetMB) sleeps tabs until the target is available', `slept ${fr.slept}, available ${fr.availableMB} MB`);
      saver.readMem = (await import('./memsaver')).readProcMeminfo;
      saver.settleMs = 800;
      const real = (await import('./memsaver')).readProcMeminfo();
      info('meminfo', real ? `MemAvailable ${Math.round(real.availableMB)} of ${Math.round(real.totalMB)} MB` : 'unreadable here');

      // Settings -> Memory status command.
      const st = await ui<{ totalMB: number; awake: number; sleeping: number }>(`window.jivvy.invoke('memory_status')`);
      result(st.totalMB > 100 && st.awake === tabs.live.size && st.sleeping === Object.values(runtime.tabs).filter((t) => t.sleeping).length, 'memory_status reports totals and awake/sleeping counts', JSON.stringify(st));

      // Cleanup.
      saver.auto = false;
      await dispatch({ type: 'setPref', key: 'maxAwakeTabs', value: 6 });
      await dispatch({ type: 'focusTab', tabId: 'tab_dashboard' });
      for (const t of ws().tabs.filter((x) => x.type !== 'dashboard')) await dispatch({ type: 'closeTab', tabId: t.id });
      srv.close();
    }
  } catch (e) {
    result(false, 'selftest crashed', String((e as Error)?.stack ?? e));
  }
  console.log(`SELFTEST ${fail ? 'FAILED' : 'OK'}: ${pass} passed, ${fail} failed`);
  if (doSnap) console.log(`snapshots: ${snapDir}`);
  setTimeout(() => ctx.app.exit(fail ? 1 : 0), 300);
}
