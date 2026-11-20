// Shared helpers for the self-test runner (selftest.ts) and the groups (selftest/*.ts).
import { BrowserWindow, nativeImage, type App, type BaseWindow, type NativeImage, type WebContentsView } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { StateStore } from '../store';
import type { TabManager } from '../tabs';
import type { MemorySaver } from '../memsaver';
import type { Blocker } from '../blocker';
import type { HistoryStore } from '../history';
import type { Trainer } from '../trainer';
import type { Downloads } from '../downloads';
import type { Permissions } from '../permissions';
import type { MenuDeps } from '../contextmenu';
import type { RuntimeState } from '../../shared/ipc';
import type { LayoutInput, Rect } from '../../shared/layout';

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
  downloads: Downloads;
  perms: Permissions;
  menuDeps: MenuDeps;
  layoutInput(): LayoutInput;
  snapshotOnly: boolean;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function waitFor(cond: () => boolean | Promise<boolean>, timeout = 10000, every = 50): Promise<boolean> {
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
export const rectEq = (a: Rect | null | undefined, b: Rect | null | undefined, tol = 1) =>
  !!a && !!b && Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol && Math.abs(a.width - b.width) <= tol && Math.abs(a.height - b.height) <= tol;
export const fmt = (r: Rect | null | undefined) => (r ? `${r.x},${r.y} ${r.width}x${r.height}` : 'none');

/** A fake Firefox profile (root + profiles.ini + places.sqlite) with `nVisits` visits spread over the last 170 days. */
export function makeFakeFirefox(ffRoot: string, nVisits: number, nPlaces = Math.round(nVisits / 5)) {
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

/** Counters for the group that is running (the runner reads and resets them between groups). */
export interface Counter { pass: number; fail: number }

/** What a group gets: the app context plus the small helpers every check uses. */
export interface T {
  ctx: TestCtx;
  store: StateStore;
  tabs: TabManager;
  runtime: RuntimeState;
  result(ok: boolean, name: string, detail?: string): void;
  info(name: string, detail: string): void;
  base(): Electron.WebContents;
  ui<R>(js: string): Promise<R>;
  dispatch(a: object): Promise<unknown>;
  ws(): StateStore['state']['workspaces'][number];
  tab(id: string): StateStore['state']['workspaces'][number]['tabs'][number] | undefined;
  bounds(id: string): Rect | null;
  slots(): Promise<Rect[]>;
  hoverBase(x: number, y: number): Promise<void>;
  save(name: string, img: NativeImage): void;
  composite(name: string): Promise<void>;
  sleep: typeof sleep;
  waitFor: typeof waitFor;
  rectEq: typeof rectEq;
  fmt: typeof fmt;
}

/** A named, independently runnable slice of the self-test. `needs` are pulled in (and run first) automatically. */
export interface Group {
  name: string;
  desc: string;
  needs: string[];
  /** Slow or needs the internet: left out of JIVVY_SELFTEST=quick. */
  slow?: boolean;
  run(t: T): Promise<void>;
}

export function makeT(ctx: TestCtx, counter: Counter): T {
  const { store, tabs, runtime } = ctx;
  const snapDir = process.env.JIVVY_SNAP_DIR || path.join(ctx.app.getPath('userData'), 'snap');
  const doSnap = process.env.JIVVY_SNAPSHOT === '1';
  if (doSnap) fs.mkdirSync(snapDir, { recursive: true });
  const result = (ok: boolean, name: string, detail = '') => {
    ok ? counter.pass++ : counter.fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
  };
  const info = (name: string, detail: string) => console.log(`INFO ${name} - ${detail}`);
  const base = () => ctx.base().webContents;
  const ui = <R>(js: string) => base().executeJavaScript(js) as Promise<R>;
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
  return { ctx, store, tabs, runtime, result, info, base, ui, dispatch, ws, tab, bounds, slots, hoverBase, save, composite, sleep, waitFor, rectEq, fmt };
}
