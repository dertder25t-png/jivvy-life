// selftest group: core. tab switch, menu, layouts, zen/auto-hide bars, tab context menu, split view, settings modal.
import { pageRects } from '../../shared/layout';
import type { LayoutMode } from '../../shared/layout';
import type { Group } from './kit';

export const core: Group = {
  name: 'core',
  desc: "tab switch, menu, layouts, zen/auto-hide bars, tab context menu, split view, settings modal",
  needs: ['tabs'],
  async run(t) {
    const { ctx, tabs, runtime, result, base, ui, dispatch, ws, tab, bounds, slots, hoverBase, composite, sleep, waitFor, rectEq, fmt } = t;
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
      // Enter from outside the view like a real pointer: a bare mouseEnter at the target is not
      // a hover transition once the rail has shrunk under it (test-only quirk, not an app bug).
      await hoverBase(20, 300);
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
  },
};
