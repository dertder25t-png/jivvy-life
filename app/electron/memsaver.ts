// Memory saver: decides which background tabs go to sleep (webContents destroyed, record kept).
// Policies: idle time, an awake-tab cap (LRU first) and a low-memory guard (Linux MemAvailable).
// What may never sleep (active/split panes, audio, pinned, unsaved input, fullscreen, fresh loads)
// is decided by TabManager.sleepBlocker; this file only picks the order and the amount.
import fs from 'node:fs';
import type { PersistedState } from '../shared/state';
import type { RuntimeState } from '../shared/ipc';
import type { TabManager } from './tabs';

const log = (...a: unknown[]) => console.error('[memsaver]', ...a);

export interface MemInfo {
  availableMB: number;
  totalMB: number;
}

/** Linux only; null elsewhere or when /proc/meminfo is unreadable. */
export function readProcMeminfo(): MemInfo | null {
  if (process.platform !== 'linux') return null;
  try {
    const txt = fs.readFileSync('/proc/meminfo', 'utf8');
    const kb = (k: string) => {
      const m = new RegExp(`^${k}:\\s+(\\d+) kB`, 'm').exec(txt);
      return m ? Number(m[1]) : NaN;
    };
    const a = kb('MemAvailable');
    const t = kb('MemTotal');
    return a > 0 && t > 0 ? { availableMB: a / 1024, totalMB: t / 1024 } : null;
  } catch {
    return null;
  }
}

/** Low when MemAvailable < max(2 GB, 12% of MemTotal). */
export const lowThresholdMB = (totalMB: number) => Math.max(2048, totalMB * 0.12);

export interface SaverDeps {
  tabs: TabManager;
  runtime: RuntimeState;
  state(): PersistedState;
  /** Resident MB of a tab's renderer, for freeMemory when MemAvailable can't be read. */
  tabMB(id: string): number;
}

export class MemorySaver {
  /** Replaceable for tests (fake MemAvailable). */
  readMem: () => MemInfo | null = readProcMeminfo;
  /** Pause between sleeps while the guard waits for the freed memory to show up. */
  settleMs = 800;
  private timer: ReturnType<typeof setInterval> | null = null;
  private kickTimer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  /** Off in the self-test, which drives the saver itself. */
  auto = true;

  constructor(private d: SaverDeps) {}

  start(tickMs = 10_000) {
    if (this.timer || !this.auto) return;
    this.timer = setInterval(() => void this.tick(), tickMs);
    this.timer.unref?.();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.kickTimer) clearTimeout(this.kickTimer);
    this.kickTimer = null;
  }

  /** Something changed (tab switched, pref changed): re-check the awake cap soon. */
  kick(ms = 600) {
    if (!this.auto) return;
    if (this.kickTimer) clearTimeout(this.kickTimer);
    this.kickTimer = setTimeout(() => {
      this.kickTimer = null;
      void this.enforce(false);
    }, ms);
    this.kickTimer.unref?.();
  }

  /** Background tabs that are awake, least recently used first. */
  private lru() {
    return [...this.d.tabs.live.values()].filter((t) => !t.attached).sort((a, b) => a.lastUsed - b.lastUsed);
  }

  async sleepOne(id: string, manual = false) {
    const ok = await this.d.tabs.sleep(id, { manual });
    if (ok) log('slept', id);
    return ok;
  }

  /** The periodic pass (10 s): idle sleep, cap, then the memory-pressure guard. */
  async tick() {
    await this.enforce(true);
    if (this.d.state().memoryGuard) await this.guard();
  }

  /** Idle timeout and awake cap. Returns how many tabs went to sleep. */
  async enforce(idle: boolean): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    let n = 0;
    try {
      const st = this.d.state();
      if (idle && st.sleepAfterMin > 0) {
        const cutoff = Date.now() - st.sleepAfterMin * 60_000;
        for (const lt of this.lru()) if (lt.lastUsed <= cutoff && (await this.sleepOne(lt.id))) n++;
      }
      let awake = this.d.tabs.live.size;
      for (const lt of this.lru()) {
        if (awake <= st.maxAwakeTabs) break;
        if (await this.sleepOne(lt.id)) {
          awake--;
          n++;
        }
      }
    } finally {
      this.busy = false;
    }
    return n;
  }

  /** Low-memory guard: sleep background tabs, LRU first, until MemAvailable recovers or none are left. */
  async guard(): Promise<number> {
    const low = (m: MemInfo) => m.availableMB < lowThresholdMB(m.totalMB);
    let m = this.readMem();
    if (!m || !low(m)) return 0;
    log(`low memory: ${Math.round(m.availableMB)} MB available of ${Math.round(m.totalMB)} MB`);
    let n = 0;
    for (const lt of this.lru()) {
      if (!(await this.sleepOne(lt.id))) continue;
      n++;
      await new Promise((r) => setTimeout(r, this.settleMs));
      m = this.readMem();
      if (!m || !low(m)) break;
    }
    return n;
  }

  /** Sleep every background tab that is allowed to sleep (Settings button). */
  async sleepAllBackground(): Promise<number> {
    let n = 0;
    for (const lt of this.lru()) if (await this.sleepOne(lt.id)) n++;
    return n;
  }

  /**
   * For features that need RAM (local AI models): put background tabs to sleep, LRU first, until
   * `targetMB` is available. Uses MemAvailable when readable, otherwise an estimate from each
   * tab's own footprint. Returns what happened.
   */
  async freeMemory(targetMB: number): Promise<{ slept: number; availableMB: number | null; satisfied: boolean }> {
    const start = this.readMem();
    let est = start ? start.availableMB : 0;
    let slept = 0;
    if (start && start.availableMB >= targetMB) return { slept, availableMB: start.availableMB, satisfied: true };
    for (const lt of this.lru()) {
      const mb = this.d.tabMB(lt.id);
      if (!(await this.sleepOne(lt.id))) continue;
      slept++;
      est += mb;
      await new Promise((r) => setTimeout(r, this.settleMs));
      const m = this.readMem();
      if (m ? m.availableMB >= targetMB : est >= targetMB) break;
    }
    const end = this.readMem();
    return { slept, availableMB: end ? end.availableMB : null, satisfied: end ? end.availableMB >= targetMB : est >= targetMB };
  }
}
