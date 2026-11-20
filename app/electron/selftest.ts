// JIVVY_SELFTEST: drive the real app (real UI views, real pages) through the browsing basics,
// print PASS/FAIL lines per group and exit. JIVVY_SNAPSHOT=1 also saves PNGs (base view, pages,
// overlay, and a composite of what's on screen) to JIVVY_SNAP_DIR.
// Always run with a throwaway --user-data-dir (npm run test:app does): it opens tabs and changes settings.
//
//   JIVVY_SELFTEST=1 | all        every group (the default)
//   JIVVY_SELFTEST=quick          everything except slow/network groups (media, perf, memsaver)
//   JIVVY_SELFTEST=core,security  just these groups, plus the ones they `needs`
//
// The checks live in selftest/*.ts, one Group per file; shared helpers are in selftest/kit.ts.
import { type Counter, type Group, type TestCtx, makeT, sleep, waitFor } from './selftest/kit';
import { tabs } from './selftest/tabs';
import { history } from './selftest/history';
import { core } from './selftest/core';
import { media } from './selftest/media';
import { security } from './selftest/security';
import { migration } from './selftest/migration';
import { predictions } from './selftest/predictions';
import { perf } from './selftest/perf';
import { browsing } from './selftest/browsing';
import { persistence } from './selftest/persistence';
import { memsaver } from './selftest/memsaver';

export type { TestCtx } from './selftest/kit';

/** Always runs first: the window is up and the base + overlay UI views are loaded. */
const setup: Group = {
  name: 'setup',
  desc: 'UI up (always runs first)',
  needs: [],
  async run(t) {
    const { ctx, base, ui, result, sleep, waitFor, composite } = t;
    const uiUp = await waitFor(() => !base().isLoading() && ui<boolean>(`!!document.querySelector('aside, header')`), 20000);
    result(uiUp, 'base UI loaded', base().getURL().replace(/#.*/, ''));
    const ovUp = await waitFor(() => !!ctx.overlay() && !ctx.overlay()!.webContents.isLoading(), 10000);
    result(ovUp, 'overlay view loaded (transparent, hidden until needed)', `attached=${ctx.overlayAttached()}`);
    await sleep(400);
    await composite('01-dashboard');
  },
};

/** Canonical order: needs always come before the group that asks for them, same order as the old single-file test. */
const GROUPS: Group[] = [tabs, history, core, media, security, migration, predictions, perf, browsing, persistence, memsaver];
const byName = new Map(GROUPS.map((g) => [g.name, g]));

/** JIVVY_SELFTEST value -> groups to run (with their needs, in canonical order), or the unknown names. */
export function selectGroups(spec: string): { groups: Group[]; unknown: string[] } {
  const want = new Set<string>();
  const unknown: string[] = [];
  const tokens = spec.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!tokens.length) tokens.push('all');
  for (const tok of tokens) {
    if (tok === '1' || tok === 'all') GROUPS.forEach((g) => want.add(g.name));
    else if (tok === 'quick') GROUPS.filter((g) => !g.slow).forEach((g) => want.add(g.name));
    else if (byName.has(tok)) want.add(tok);
    else unknown.push(tok);
  }
  const add = (n: string) => {
    for (const d of byName.get(n)!.needs) add(d);
    want.add(n);
  };
  [...want].forEach(add);
  return { groups: GROUPS.filter((g) => want.has(g.name)), unknown };
}

export async function runSelfTest(ctx: TestCtx) {
  const spec = ctx.snapshotOnly ? 'all' : process.env.JIVVY_SELFTEST ?? 'all';
  const { groups, unknown } = selectGroups(spec);
  if (unknown.length) {
    console.log(`SELFTEST FAILED: unknown group${unknown.length > 1 ? 's' : ''} ${unknown.map((u) => `"${u}"`).join(', ')}`);
    console.log(`valid groups: ${GROUPS.map((g) => g.name).join(', ')}  (also: all, quick)`);
    for (const g of GROUPS) console.log(`  ${g.name.padEnd(12)} ${g.slow ? '[slow] ' : ''}${g.needs.length ? `(needs ${g.needs.join(', ')}) ` : ''}${g.desc}`);
    setTimeout(() => ctx.app.exit(2), 100);
    return;
  }
  const snapDir = process.env.JIVVY_SNAP_DIR || `${ctx.app.getPath('userData')}/snap`;
  const doSnap = process.env.JIVVY_SNAPSHOT === '1';
  const counter: Counter = { pass: 0, fail: 0 };
  const t = makeT(ctx, counter);
  let pass = 0;
  let fail = 0;
  const crashed = new Set<string>();

  // Keep the window on top: a covered window gets no frame callbacks on Wayland, which stalls
  // CSS transitions and rAF-aligned input in the UI views and makes timing-based checks flaky.
  ctx.win().setAlwaysOnTop(true);
  ctx.win().focus();

  console.log(`groups: ${['setup', ...groups.map((g) => g.name)].join(', ')}`);
  const t00 = Date.now();
  for (const g of [setup, ...groups]) {
    counter.pass = 0;
    counter.fail = 0;
    console.log(`---- ${g.name}: ${g.desc} ----`);
    const t0 = Date.now();
    const bad = g.needs.find((n) => crashed.has(n));
    if (bad) {
      crashed.add(g.name);
      t.result(false, `${g.name} skipped: needed group "${bad}" crashed`);
    } else {
      try {
        await g.run(t);
      } catch (e) {
        crashed.add(g.name);
        t.result(false, 'selftest crashed', `[${g.name}] ${String((e as Error)?.stack ?? e)}`);
      }
    }
    pass += counter.pass;
    fail += counter.fail;
    console.log(`GROUP ${g.name}: ${counter.fail ? 'FAIL' : 'ok'} - ${counter.pass} passed, ${counter.fail} failed (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  }
  console.log(`total time ${((Date.now() - t00) / 1000).toFixed(1)} s`);
  console.log(`SELFTEST ${fail ? 'FAILED' : 'OK'}: ${pass} passed, ${fail} failed`);
  if (doSnap) console.log(`snapshots: ${snapDir}`);
  setTimeout(() => ctx.app.exit(fail ? 1 : 0), 300);
}
