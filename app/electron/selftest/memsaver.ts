// selftest group: memsaver. memory saver: sleeping tabs, awake cap, never-sleep rules, pressure guard.
import fs from 'node:fs';
import type { Group } from './kit';

export const memsaver: Group = {
  name: 'memsaver',
  desc: "memory saver: sleeping tabs, awake cap, never-sleep rules, pressure guard",
  needs: [],
  slow: true,
  async run(t) {
    const { ctx, tabs, runtime, result, info, ui, dispatch, ws, tab, sleep, waitFor } = t;
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
    saver.readMem = (await import('../memsaver')).readProcMeminfo;
    saver.settleMs = 800;
    const real = (await import('../memsaver')).readProcMeminfo();
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
  },
};
