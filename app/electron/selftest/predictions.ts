// selftest group: predictions. trainer, inline autocomplete, dashboard routing.
import fs from 'node:fs';
import path from 'node:path';
import type { Group } from './kit';

export const predictions: Group = {
  name: 'predictions',
  desc: "trainer, inline autocomplete, dashboard routing",
  needs: ['tabs'],
  async run(t) {
    const { ctx, runtime, result, info, base, ui, dispatch, ws, tab, sleep, waitFor, fmt } = t;
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
  },
};
