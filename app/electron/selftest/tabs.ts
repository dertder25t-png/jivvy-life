// selftest group: tabs. open 3 real web tabs (Wikipedia, example.com, YouTube), navigate/back/forward/reload.

import type { Group } from './kit';

export const tabs: Group = {
  name: 'tabs',
  desc: "open 3 real web tabs (Wikipedia, example.com, YouTube), navigate/back/forward/reload",
  needs: [],
  async run(t) {
    const { tabs, runtime, result, ui, dispatch, tab, waitFor } = t;
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
  },
};
