// selftest group: browsing. downloads, find, zoom, closed tabs, shortcuts, permissions, page context menu.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { session as electronSession, safeStorage } from 'electron';
import { isRunnable, safeName } from '../downloads';
import { menuTemplate } from '../contextmenu';
import { levelFor, percentFor } from '../../shared/zoom';
import type { Group } from './kit';

export const browsing: Group = {
  name: 'browsing',
  desc: "downloads, find, zoom, closed tabs, shortcuts, permissions, page context menu",
  needs: [],
  async run(t) {
    const { ctx, tabs, runtime, result, base, ui, dispatch, ws, tab, composite, sleep, waitFor, fmt } = t;
  // ---- 12d. browsing polish: downloads, find, zoom, closed tabs, shortcuts, permissions, context menu ----
  {
    const http = await import('node:http');
    const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jivvy-dl-'));
    const realDl = ctx.app.getPath('downloads');
    const oldDir = ctx.downloads.dir;
    ctx.downloads.dir = dlDir;
    const fileBody = `hello download ${'x'.repeat(5000)}`;
    const fileName = `jivvy-test-${process.pid}.txt`;
    const slowTimers = new Set<NodeJS.Timeout>();
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://x');
      if (u.pathname === '/file') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${fileName}"`, 'Content-Length': Buffer.byteLength(fileBody) });
        res.end(fileBody);
      } else if (u.pathname === '/slow') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="slow.bin"', 'Content-Length': 5_000_000 });
        res.write(Buffer.alloc(100_000, 1));
        const t = setInterval(() => res.write(Buffer.alloc(1000, 1)), 200);
        slowTimers.add(t);
        res.on('close', () => clearInterval(t));
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!doctype html><title>${u.pathname}</title><body style="font:16px sans-serif"><h1>Polish ${u.pathname}</h1><p>needle one, needle two, needle three.</p><p>Another needle here and one more needle there.</p><textarea id="t">teh</textarea></body>`);
      }
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    const O = `http://127.0.0.1:${port}`;
    const O2 = `http://localhost:${port}`;
    const ov = () => ctx.overlay()!.webContents;
    const key = (wc: Electron.WebContents, keyCode: string, modifiers: Array<'control' | 'shift' | 'alt'> = []) => {
      wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
      wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    };
    const openLocal = async (id: string, url: string) => {
      await dispatch({ type: 'openTab', tab: { id, title: id, type: 'web', url } });
      await waitFor(() => !!tabs.webContentsOf(id) && runtime.tabs[id]?.loading === false && tabs.webContentsOf(id)!.getURL().startsWith('http://'), 10000);
      await sleep(200);
    };
    await openLocal('tab_p1', `${O}/page`);
    const wcP = () => tabs.webContentsOf('tab_p1')!;
    wcP().focus();

    // -- downloads --
    const before = runtime.downloads.length;
    wcP().downloadURL(`${O}/file`);
    const dlDone = await waitFor(() => runtime.downloads[0]?.state === 'done', 10000);
    const landed = path.join(dlDir, fileName);
    result(dlDone && fs.existsSync(landed) && fs.readFileSync(landed, 'utf8') === fileBody, 'download: a local file completes into the scratch downloads dir', `${runtime.downloads[0]?.name} ${runtime.downloads[0]?.received} bytes`);
    result(ctx.downloads.dir !== realDl && !fs.existsSync(path.join(realDl, fileName)), 'download: the real ~/Downloads is untouched by tests');
    result(runtime.downloads.length === before + 1 && runtime.downloads[0].total === Buffer.byteLength(fileBody) && runtime.downloads[0].host === '127.0.0.1', 'download: tracked in state with size and host');
    result(!!runtime.hud.toast && /Downloaded/.test(runtime.hud.toast.text), 'download: finished toast shown', runtime.hud.toast?.text);
    await ui(`window.jivvy.invoke('toast_dismiss')`);
    wcP().downloadURL(`${O}/file`);
    await waitFor(() => runtime.downloads.filter((d) => d.state === 'done').length >= 2, 10000);
    await ui(`window.jivvy.invoke('toast_dismiss')`);
    const second = path.join(dlDir, fileName.replace(/\.txt$/, ' (1).txt'));
    result(fs.existsSync(second) && fs.readFileSync(landed, 'utf8') === fileBody, 'download: same name gets a unique name, nothing overwritten', path.basename(second));
    result(safeName('../../etc/passwd') === 'passwd' && safeName('..\\..\\x.sh') === 'x.sh' && safeName('.hidden') === 'hidden' && isRunnable('setup.EXE') && isRunnable('a.AppImage') && !isRunnable('a.pdf'), 'download: names are sanitized; executables are never opened (shown in folder instead)');
    wcP().downloadURL(`${O}/slow`);
    const running = await waitFor(() => runtime.downloads[0]?.state === 'progressing' && runtime.downloads[0].received > 50_000, 10000);
    const slowId = runtime.downloads[0]?.id;
    result(running && runtime.downloads[0].total === 5_000_000, 'download: progress is tracked while running', `${runtime.downloads[0]?.received} of ${runtime.downloads[0]?.total}`);
    const btn = await waitFor(() => ui<boolean>(`!!document.querySelector('[data-downloads-button]')`), 3000);
    result(btn, 'downloads button appears in the chrome while downloads exist');
    await ui(`window.jivvy.overlayOpen({ kind: 'downloads', anchor: { x: 1400, y: 40, width: 0, height: 0 } })`);
    await waitFor(() => runtime.overlay?.kind === 'downloads' && !!ctx.overlayRect(), 4000);
    await sleep(300);
    const rows = await ov().executeJavaScript(`document.querySelectorAll('[data-download-row]').length`);
    const hasBar = await ov().executeJavaScript(`!!document.querySelector('[data-download-row] [role=progressbar]') && !!document.querySelector('[data-action=download-cancel]') && !!document.querySelector('[data-action=download-open]') && !!document.querySelector('[data-action=download-show]')`);
    result(rows === runtime.downloads.length && hasBar, 'downloads panel: rows with progress bar, cancel, open, show in folder', `${rows} rows`);
    await composite('06-downloads-panel');
    await ov().executeJavaScript(`document.querySelector('[data-action=download-cancel]').click()`);
    const cancelled = await waitFor(() => runtime.downloads.find((d) => d.id === slowId)?.state === 'cancelled', 5000);
    result(cancelled, 'downloads panel: cancel stops a running download');
    await ov().executeJavaScript(`document.querySelector('[data-action=downloads-clear]').click()`);
    result(await waitFor(() => runtime.downloads.length === 0, 3000), 'downloads panel: clear empties the list');
    await ui(`window.jivvy.overlayClose()`);
    await waitFor(() => !ctx.overlayAttached(), 2000);
    for (const t of slowTimers) clearInterval(t);

    // -- find in page --
    await dispatch({ type: 'focusTab', tabId: 'tab_p1' });
    wcP().focus();
    key(wcP(), 'F', ['control']);
    const findUp = await waitFor(() => !!runtime.hud.find && runtime.overlay?.kind === 'hud' && !!ctx.overlayRect(), 4000);
    result(findUp, 'Ctrl+F opens the find bar in the overlay', `overlay ${fmt(ctx.overlayRect())}`);
    await sleep(300);
    result(await ov().executeJavaScript(`document.activeElement && document.activeElement.hasAttribute('data-find-input')`), 'find bar input has the keyboard');
    // Type into the real input (React-compatible setter + input event), like a user.
    await ov().executeJavaScript(`(() => { const i = document.querySelector('[data-find-input]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'needle'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    const counted = await waitFor(() => runtime.hud.find?.total === 5 && runtime.hud.find.active === 1, 5000);
    await sleep(200);
    const shown = await ov().executeJavaScript(`document.querySelector('[data-find-count]')?.textContent`);
    result(counted && shown === '1/5', 'find shows a match count ("1/5")', `${shown} (hud ${runtime.hud.find?.active}/${runtime.hud.find?.total})`);
    await composite('07-find-bar');
    const enter = (shift: boolean) => ov().executeJavaScript(`document.querySelector('[data-find-input]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: ${shift}, bubbles: true, cancelable: true }))`);
    await enter(false);
    const next = await waitFor(() => runtime.hud.find?.active === 2, 3000);
    await enter(true);
    const prev = await waitFor(() => runtime.hud.find?.active === 1, 3000);
    result(next && prev, 'Enter / Shift+Enter step to the next / previous match', `2 then ${runtime.hud.find?.active}`);
    await sleep(100);
    ov().sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    const closedFind = await waitFor(() => runtime.hud.find === null && !ctx.overlayAttached(), 3000);
    result(closedFind, 'Esc closes the find bar (selection cleared)');

    // -- zoom --
    key(wcP(), '=', ['control']);
    const z1 = await waitFor(() => ctx.store.state.siteZoom['127.0.0.1'] === 110 && Math.abs(wcP().getZoomLevel() - levelFor(110)) < 1e-6, 3000);
    result(z1 && percentFor(wcP().getZoomLevel()) === 110, 'Ctrl+= zooms to 110% and saves it for the host', JSON.stringify(ctx.store.state.siteZoom));
    await waitFor(() => runtime.hud.zoom?.percent === 110 && runtime.overlay?.kind === 'hud' && !!ctx.overlayRect(), 3000);
    await sleep(250);
    const badge = await ov().executeJavaScript(`document.querySelector('[data-zoom-badge]')?.textContent`);
    result(/110%/.test(String(badge)) && /Reset/.test(String(badge)), 'zoom indicator shows "110%" with a reset button', String(badge));
    key(wcP(), '=', ['control']);
    await waitFor(() => ctx.store.state.siteZoom['127.0.0.1'] === 125, 3000);
    key(wcP(), '-', ['control']);
    await waitFor(() => ctx.store.state.siteZoom['127.0.0.1'] === 110, 3000);
    await dispatch({ type: 'navigateTab', tabId: 'tab_p1', url: `${O2}/page` });
    await waitFor(() => wcP().getURL().startsWith(O2) && runtime.tabs.tab_p1?.loading === false, 8000);
    const otherHost = await waitFor(() => Math.abs(wcP().getZoomLevel()) < 1e-6, 3000);
    await dispatch({ type: 'navigateTab', tabId: 'tab_p1', url: `${O}/page` });
    await waitFor(() => wcP().getURL().startsWith(O) && runtime.tabs.tab_p1?.loading === false, 8000);
    const backHost = await waitFor(() => percentFor(wcP().getZoomLevel()) === 110, 3000);
    result(otherHost && backHost, 'zoom is per site: another host stays at 100%, coming back restores 110%');
    await sleep(700);
    const stateFile = fs.readFileSync(path.join(ctx.app.getPath('userData'), 'jivvy-state.json'), 'utf8');
    result(/"siteZoom":\{"127\.0\.0\.1":110\}/.test(stateFile), 'zoom level persisted by host in jivvy-state.json');
    wcP().sendInputEvent({ type: 'mouseWheel', x: 200, y: 200, deltaX: 0, deltaY: -120, wheelTicksX: 0, wheelTicksY: 1, modifiers: ['control'], hasPreciseScrollingDeltas: false });
    result(await waitFor(() => (ctx.store.state.siteZoom['127.0.0.1'] ?? 100) > 110, 3000), 'Ctrl+wheel up zooms the page in', JSON.stringify(ctx.store.state.siteZoom));
    key(wcP(), '=', ['control']);
    await waitFor(() => runtime.hud.zoom !== null && runtime.overlay?.kind === 'hud' && !!ctx.overlayRect(), 3000);
    await waitFor(() => ov().executeJavaScript(`!!document.querySelector('[data-zoom-reset]')`), 3000);
    await ov().executeJavaScript(`document.querySelector('[data-zoom-reset]').click()`);
    result(await waitFor(() => !('127.0.0.1' in ctx.store.state.siteZoom) && Math.abs(wcP().getZoomLevel()) < 1e-6, 3000), 'zoom reset button returns the site to 100%');
    await waitFor(() => runtime.hud.zoom === null && !ctx.overlayAttached(), 4000);

    // -- keyboard shortcuts, closed tabs --
    const tabCount = () => ws().tabs.length;
    const n0 = tabCount();
    await openLocal('tab_p2', `${O}/page-a`);
    await dispatch({ type: 'navigateTab', tabId: 'tab_p2', url: `${O}/page-b` });
    await waitFor(() => tabs.webContentsOf('tab_p2')?.getURL() === `${O}/page-b` && runtime.tabs.tab_p2?.loading === false, 8000);
    await sleep(300);
    tabs.webContentsOf('tab_p2')!.focus();
    key(tabs.webContentsOf('tab_p2')!, 'W', ['control']);
    const closedByKey = await waitFor(() => !tab('tab_p2') && tabCount() === n0, 3000);
    result(closedByKey, 'Ctrl+W closes the active tab (sendInputEvent into the page)');
    key(base(), 'T', ['control', 'shift']);
    const reopened = await waitFor(() => tabCount() === n0 + 1 && ws().tabs.some((t) => t.url === `${O}/page-b`), 4000);
    const rid = ws().tabs.find((t) => t.url === `${O}/page-b`)?.id;
    await waitFor(() => !!rid && runtime.tabs[rid]?.loading === false && !!tabs.webContentsOf(rid), 8000);
    result(reopened && !!rid && ws().primaryTabId === rid, 'Ctrl+Shift+T reopens the last closed tab at its URL', `${rid} ${tab(rid ?? '')?.url}`);
    result(!!rid && (await waitFor(() => runtime.tabs[rid]?.canGoBack === true, 5000)), 'reopened tab keeps its back/forward history');
    key(base(), 'T', ['control']);
    const omni = await waitFor(() => runtime.overlay?.kind === 'omnibox' && ctx.overlayAttached(), 3000);
    result(omni, 'Ctrl+T opens the omnibox for a new tab');
    await sleep(300);
    ov().sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    await waitFor(() => !ctx.overlayAttached(), 3000);
    const ids = ws().tabs.map((t) => t.id);
    const cur = ws().primaryTabId!;
    key(base(), 'Tab', ['control']);
    const sw = await waitFor(() => ws().primaryTabId === ids[(ids.indexOf(cur) + 1) % ids.length], 3000);
    key(base(), '1', ['control']);
    const first = await waitFor(() => ws().primaryTabId === ids[0], 3000);
    result(sw && first, 'Ctrl+Tab and Ctrl+1 switch tabs');
    await dispatch({ type: 'focusTab', tabId: 'tab_p1' });
    key(wcP(), 'D', ['control']);
    const pinned = await waitFor(() => tab('tab_p1')?.pinned === true, 3000);
    key(wcP(), 'D', ['control']);
    result(pinned && (await waitFor(() => !tab('tab_p1')?.pinned, 3000)), 'Ctrl+D pins and unpins the tab');
    if (rid) await dispatch({ type: 'closeTab', tabId: rid });

    // -- permissions --
    const geo = () => wcP().executeJavaScript(`new Promise((r) => navigator.geolocation.getCurrentPosition(() => r('ok'), (e) => r('err' + e.code), { timeout: 15000 }))`) as Promise<string>;
    await dispatch({ type: 'focusTab', tabId: 'tab_p1' });
    const p1 = geo();
    const promptUp = await waitFor(() => !!runtime.hud.perm && runtime.overlay?.kind === 'hud' && !!ctx.overlayRect(), 5000);
    await sleep(300);
    const ptxt = await ov().executeJavaScript(`document.querySelector('[data-perm-prompt]')?.textContent || ''`);
    const rememberOn = await ov().executeJavaScript(`document.querySelector('[data-perm-remember]')?.checked`);
    result(promptUp && /127\.0\.0\.1:\d+ wants to know your location/.test(ptxt) && /Allow/.test(ptxt) && /Block/.test(ptxt) && rememberOn === true, 'permission prompt for geolocation: site name, Allow / Block, "Remember" checked by default', ptxt.slice(0, 80));
    await composite('08-permission-prompt');
    await ov().executeJavaScript(`document.querySelector('[data-perm-block]').click()`);
    const r1 = await p1;
    result(r1 === 'err1' && ctx.store.state.sitePermissions[O]?.geolocation === 'block', 'Block denies the request and is remembered per origin', `${r1} ${JSON.stringify(ctx.store.state.sitePermissions)}`);
    const r2 = await geo();
    result(r2 === 'err1' && !runtime.hud.perm, 'a remembered Block denies silently (no second prompt)', r2);
    await ui(`window.jivvy.overlayOpen({ kind: 'settings' })`);
    await waitFor(() => runtime.overlay?.kind === 'settings' && !!ctx.overlayRect(), 4000);
    await waitFor(() => ov().executeJavaScript(`!!document.querySelector('[data-settings-tab="permissions"]')`), 4000);
    await ov().executeJavaScript(`document.querySelector('[data-settings-tab="permissions"]').click()`);
    const listed =await waitFor(() => ov().executeJavaScript(`!!document.querySelector('[data-site-permission="${O}|geolocation"]')`), 4000);
    result(listed, 'Settings -> Site permissions lists the remembered decision');
    await ov().executeJavaScript(`document.querySelector('[data-site-permission="${O}|geolocation"] button').click()`);
    result(await waitFor(() => !ctx.store.state.sitePermissions[O], 3000), 'Settings -> Site permissions: a decision can be removed');
    await ui(`window.jivvy.overlayClose()`);
    await waitFor(() => !ctx.overlayAttached(), 2000);
    // Unanswered prompts deny themselves (test shortens the 60 s timeout).
    ctx.perms.timeoutMs = 800;
    const p3 = geo();
    await waitFor(() => !!runtime.hud.perm, 4000);
    const r3 = await p3;
    result(r3 === 'err1' && !runtime.hud.perm && !ctx.store.state.sitePermissions[O], 'an ignored prompt auto-denies and remembers nothing', r3);
    ctx.perms.timeoutMs = 60_000;
    const pageSes = electronSession.fromPartition('persist:jivvy');
    result(ctx.perms.check('fullscreen', O) && !ctx.perms.check('geolocation', O) && !ctx.perms.check('serial', O) && !ctx.perms.check('media', O, ['video']), 'permission check handler: fullscreen yes; undecided or unlisted no');
    result(pageSes.isSpellCheckerEnabled() && pageSes.getSpellCheckerLanguages().join() === 'en-US', 'spellcheck enabled in the page session (en-US)', pageSes.getSpellCheckerLanguages().join());

    // -- page context menu (native; checked through its template) --
    const params = (o: object) => ({ x: 10, y: 10, linkURL: '', srcURL: '', mediaType: 'none', selectionText: '', isEditable: false, misspelledWord: '', dictionarySuggestions: [], editFlags: { canCut: false, canCopy: false, canPaste: true, canSelectAll: true }, ...o }) as unknown as Parameters<typeof menuTemplate>[2];
    const labels = (o: object) => menuTemplate(ctx.menuDeps, wcP(), params(o)).map((i) => i.label ?? '-');
    const L = labels({ linkURL: 'https://example.com/split-test', selectionText: 'hello world' });
    const need = ['Open link in new tab', 'Open in split pane', 'Copy link', 'Copy', 'Back', 'Forward', 'Reload', 'View page source', 'Inspect'];
    result(need.every((n) => L.includes(n)) && L.some((x) => /^Search Google for/.test(x)) && L.some((x) => /^Ask Claude about/.test(x)), 'context menu: link + selection items (open, split, copy, search, ask, nav, source, inspect)', L.join(' | '));
    const Li = labels({ mediaType: 'image', srcURL: 'https://example.com/a.png' });
    const Le = labels({ isEditable: true, misspelledWord: 'teh', dictionarySuggestions: ['the', 'ten'], editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true } });
    result(['Open image in new tab', 'Save image as…', 'Copy image'].every((n) => Li.includes(n)) && ['Cut', 'Copy', 'Paste', 'Select all', 'the', 'ten', 'Add to dictionary'].every((n) => Le.includes(n)), 'context menu: image items; editable items with spelling suggestions');
    const tpl = menuTemplate(ctx.menuDeps, wcP(), params({ linkURL: 'https://example.com/split-test', selectionText: 'hello world' }));
    const nTabs = tabCount();
    (tpl.find((i) => i.label === 'Open in split pane')!.click as () => void)();
    const split = await waitFor(() => ws().layout === 'split-vertical' && !!ws().secondaryTabId && tab(ws().secondaryTabId!)?.url === 'https://example.com/split-test', 3000);
    result(split && tabCount() === nTabs + 1, 'context menu: "Open in split pane" opens the link in the second pane');
    (tpl.find((i) => /^Search Google for/.test(i.label ?? ''))!.click as () => void)();
    (tpl.find((i) => /^Ask Claude about/.test(i.label ?? ''))!.click as () => void)();
    const routed = await waitFor(() => ws().tabs.some((t) => t.url?.startsWith('https://www.google.com/search?q=hello%20world') || t.url?.startsWith('https://www.google.com/search?q=hello+world')) && ws().tabs.some((t) => t.url?.startsWith('https://claude.ai/new?q=hello')), 3000);
    result(routed, 'context menu: search / ask use the router (Google, Claude)');
    for (const t of ws().tabs.filter((x) => x.url?.includes('example.com/split-test') || x.url?.includes('google.com/search') || x.url?.includes('claude.ai/new'))) await dispatch({ type: 'closeTab', tabId: t.id });
    if (ws().layout === 'split-vertical') await dispatch({ type: 'toggleSplitPane' });

    // cleanup
    for (const id of ['tab_p1']) await dispatch({ type: 'closeTab', tabId: id });
    await dispatch({ type: 'focusTab', tabId: 'tab_dashboard' });
    srv.close();
    ctx.downloads.dir = oldDir;
    fs.rmSync(dlDir, { recursive: true, force: true });
  }
  },
};
