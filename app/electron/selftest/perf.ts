// selftest group: perf. 20k-visit import and Retrain now with lag monitors.
import fs from 'node:fs';
import path from 'node:path';
import { lagStats, resetLag, startLagMon } from '../lagmon';
import { makeFakeFirefox } from './kit';
import type { Group } from './kit';

export const perf: Group = {
  name: 'perf',
  desc: "20k-visit import and Retrain now with lag monitors",
  needs: [],
  slow: true,
  async run(t) {
    const { ctx, runtime, result, info, base, ui, tab, sleep, waitFor } = t;
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
    // Settings is tabbed: the retrain button lives on the "History & predictions" tab.
    await waitFor(() => ov().executeJavaScript(`!!document.querySelector('[data-settings-tab="history"]')`), 4000);
    await ov().executeJavaScript(`document.querySelector('[data-settings-tab="history"]').click()`);
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
  },
};
