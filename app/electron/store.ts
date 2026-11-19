// Single source of truth for workspaces, tabs, folders, layout, settings and notes.
// Persisted as JSON in userData with debounced, atomic (write tmp + fsync + rename) writes.
import fs from 'node:fs';
import path from 'node:path';
import { hydrate, reduce, PERSISTED_KEYS, type Action, type PersistedState } from '../shared/state';

const SAVE_DEBOUNCE_MS = 400;
const log = (...a: unknown[]) => console.error('[store]', ...a);

export type ChangeListener = (changed: Partial<PersistedState>, prev: PersistedState) => void;

export class StateStore {
  state: PersistedState;
  private file: string;
  private timer: NodeJS.Timeout | null = null;
  private writing: Promise<void> = Promise.resolve();
  private dirty = false;
  private listeners: ChangeListener[] = [];

  constructor(dir: string) {
    this.file = path.join(dir, 'jivvy-state.json');
    let raw: Partial<PersistedState> | null = null;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        log('could not read state, starting fresh (old file kept as .corrupt):', String(e));
        try {
          fs.copyFileSync(this.file, `${this.file}.corrupt`);
        } catch {
          /* nothing to keep */
        }
      }
    }
    this.state = hydrate(raw);
  }

  onChange(fn: ChangeListener) {
    this.listeners.push(fn);
  }

  dispatch(a: Action): boolean {
    const prev = this.state;
    const next = reduce(prev, a);
    if (next === prev) return false;
    const changed: Partial<PersistedState> = {};
    for (const k of PERSISTED_KEYS) if (next[k] !== prev[k]) (changed as Record<string, unknown>)[k] = next[k];
    if (!Object.keys(changed).length) return false;
    this.state = next;
    this.scheduleSave();
    for (const fn of this.listeners) fn(changed, prev);
    return true;
  }

  private scheduleSave() {
    this.dirty = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.writing = this.writing.then(() => this.saveAsync());
    }, SAVE_DEBOUNCE_MS);
  }

  private async saveAsync() {
    if (!this.dirty) return;
    this.dirty = false;
    const data = JSON.stringify(this.state);
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
      const fh = await fs.promises.open(tmp, 'w', 0o600);
      try {
        await fh.writeFile(data, 'utf8');
        await fh.sync();
      } finally {
        await fh.close();
      }
      await fs.promises.rename(tmp, this.file);
    } catch (e) {
      this.dirty = true;
      log('save failed:', String(e));
    }
  }

  /** Synchronous final write on quit. */
  flushSync() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.dirty) return;
    this.dirty = false;
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const fd = fs.openSync(tmp, 'w', 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(this.state), 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, this.file);
    } catch (e) {
      log('final save failed:', String(e));
    }
  }
}
