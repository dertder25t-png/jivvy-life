// Downloads for the page session: always saved into one directory (~/Downloads) under a name
// that does not exist yet, tracked in runtime state (newest first, last 50), never auto-opened.
// The UI only ever refers to a download by id; paths never come from a renderer.
import { dialog, shell, type BaseWindow, type DownloadItem, type Session, type WebContents } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { DownloadInfo, RuntimeState } from '../shared/ipc';

const log = (...a: unknown[]) => console.error('[downloads]', ...a);

export const MAX_DOWNLOADS = 50;
const PUSH_EVERY_MS = 250;
/** Things the desktop would run or install when opened. "Open" on these shows the file in its folder instead. */
const RUNNABLE = new Set([
  '.exe', '.msi', '.bat', '.cmd', '.com', '.scr', '.pif', '.lnk', '.hta', '.reg', '.vbs', '.vbe', '.wsf', '.ps1',
  '.sh', '.bash', '.csh', '.run', '.bin', '.appimage', '.desktop', '.command', '.jar',
  '.py', '.pl', '.rb', '.deb', '.rpm', '.apk', '.dmg', '.pkg', '.app', '.flatpakref', '.snap',
]);
export const isRunnable = (name: string) => RUNNABLE.has(path.extname(name).toLowerCase());

/** A plain file name: no directories, no control characters, no leading dots, bounded length. */
export function safeName(raw: string, fallback = 'download'): string {
  let n = path.basename(String(raw || '').replace(/\\/g, '/'));
  n = n.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').replace(/^\.+/, '').trim();
  if (n.length > 180) {
    const ext = path.extname(n).slice(0, 20);
    n = n.slice(0, 180 - ext.length) + ext;
  }
  return n || fallback;
}

/** `dir/name`, or `dir/name (1).ext`, `(2)`, ... : the first path that is free and not reserved. */
export function uniquePath(dir: string, name: string, reserved: Set<string> = new Set()): string {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 0; i < 100_000; i++) {
    const p = path.join(dir, i === 0 ? name : `${stem} (${i})${ext}`);
    if (!fs.existsSync(p) && !reserved.has(p)) return p;
  }
  return path.join(dir, `${stem}-${Date.now()}${ext}`);
}

export interface DownloadsHost {
  runtimeChanged(): void;
  toast(text: string, downloadId?: string): void;
  window(): BaseWindow | null;
}

interface Entry {
  item: DownloadItem | null;
  info: DownloadInfo;
  path: string;
  lastPush: number;
  lastBytes: number;
  lastT: number;
}

export class Downloads {
  /** Where downloads go. The self-test points this at a scratch directory. */
  dir: string;
  private entries = new Map<string, Entry>();
  private reserved = new Set<string>();
  /** "Save image as…": url -> the path the user picked in the dialog. */
  private forced = new Map<string, string>();
  private n = 0;

  constructor(private runtime: RuntimeState, private host: DownloadsHost, dir: string) {
    this.dir = dir;
  }

  attach(ses: Session) {
    ses.on('will-download', (_e, item) => this.start(item));
  }

  private start(item: DownloadItem) {
    const url = item.getURL();
    const forced = this.forced.get(url);
    this.forced.delete(url);
    let target: string;
    try {
      if (forced) target = forced;
      else {
        fs.mkdirSync(this.dir, { recursive: true });
        target = uniquePath(this.dir, safeName(item.getFilename()), this.reserved);
      }
    } catch (e) {
      log('cannot prepare download', String(e).slice(0, 120));
      item.cancel();
      return;
    }
    this.reserved.add(target);
    item.setSavePath(target);
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {
      /* data: or blob: */
    }
    const info: DownloadInfo = {
      id: `dl_${++this.n}`,
      name: path.basename(target),
      host,
      received: 0,
      total: Math.max(0, item.getTotalBytes()),
      speed: 0,
      state: 'progressing',
      startedAt: Date.now(),
    };
    const ent: Entry = { item, info, path: target, lastPush: 0, lastBytes: 0, lastT: Date.now() };
    this.entries.set(info.id, ent);
    this.runtime.downloads = [info, ...this.runtime.downloads].slice(0, MAX_DOWNLOADS);
    this.pushNow();

    item.on('updated', (_e, state) => {
      const now = Date.now();
      const bytes = item.getReceivedBytes();
      const dt = now - ent.lastT;
      if (dt >= 400) {
        const inst = ((bytes - ent.lastBytes) * 1000) / dt;
        ent.info = { ...ent.info, speed: ent.info.speed ? ent.info.speed * 0.6 + inst * 0.4 : inst };
        ent.lastBytes = bytes;
        ent.lastT = now;
      }
      ent.info = { ...ent.info, received: bytes, total: Math.max(0, item.getTotalBytes()), ...(state === 'interrupted' ? { speed: 0 } : {}) };
      this.replace(ent);
      if (now - ent.lastPush >= PUSH_EVERY_MS) this.pushNow(ent);
    });
    item.once('done', (_e, state) => {
      this.reserved.delete(target);
      ent.item = null;
      const st = state === 'completed' ? 'done' : state === 'cancelled' ? 'cancelled' : 'failed';
      ent.info = { ...ent.info, state: st, speed: 0, received: st === 'done' ? Math.max(ent.info.received, item.getReceivedBytes()) : ent.info.received };
      if (st === 'done' && ent.info.total === 0) ent.info.total = ent.info.received;
      this.replace(ent);
      this.pushNow(ent);
      if (st === 'done') this.host.toast(`Downloaded ${ent.info.name}`, ent.info.id);
      else if (st === 'failed') this.host.toast(`Download failed: ${ent.info.name}`, ent.info.id);
    });
  }

  /** Swap the entry's info into the runtime list (kept newest first). */
  private replace(ent: Entry) {
    const i = this.runtime.downloads.findIndex((d) => d.id === ent.info.id);
    if (i < 0) return;
    const list = this.runtime.downloads.slice();
    list[i] = ent.info;
    this.runtime.downloads = list;
  }

  private pushNow(ent?: Entry) {
    if (ent) ent.lastPush = Date.now();
    this.host.runtimeChanged();
  }

  cancel(id: string) {
    this.entries.get(id)?.item?.cancel();
  }

  /** Open the file, unless it is something the desktop would run: then show it in its folder. */
  async open(id: string): Promise<boolean> {
    const e = this.entries.get(id);
    if (!e || e.info.state !== 'done' || !fs.existsSync(e.path)) return false;
    if (isRunnable(e.path)) {
      shell.showItemInFolder(e.path);
      return true;
    }
    return (await shell.openPath(e.path)) === '';
  }

  show(id: string): boolean {
    const e = this.entries.get(id);
    if (!e || !fs.existsSync(e.path)) return false;
    shell.showItemInFolder(e.path);
    return true;
  }

  /** Remove every finished, failed or cancelled row (running downloads stay). */
  clear() {
    this.runtime.downloads = this.runtime.downloads.filter((d) => d.state === 'progressing');
    for (const [id, e] of this.entries) if (e.info.state !== 'progressing') this.entries.delete(id);
    this.host.runtimeChanged();
  }

  /** "Save image as…": ask where, then download that URL there (the dialog confirms overwrites). */
  async saveAs(wc: WebContents, url: string) {
    if (!/^https?:/i.test(url)) return;
    let name = 'image';
    try {
      name = safeName(decodeURIComponent(path.basename(new URL(url).pathname)), 'image');
    } catch {
      /* keep default */
    }
    const parent = this.host.window();
    const opts = { defaultPath: path.join(this.dir, name) };
    const res = parent ? await dialog.showSaveDialog(parent as Electron.BrowserWindow, opts) : await dialog.showSaveDialog(opts);
    if (res.canceled || !res.filePath) return;
    this.forced.set(url, res.filePath);
    if (!wc.isDestroyed()) wc.downloadURL(url);
  }
}
