import { TelemetryEvent } from '../types/workspace';
import { api, isSignedIn } from './apiClient';

const IDLE_THRESHOLD_MS = 180_000; // 3 minutes
const QUEUE_KEY = 'life_app_telemetry_queue_v1';
const MAX_QUEUE = 2000;

function loadQueue(): TelemetryEvent[] {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
  } catch {
    return [];
  }
}

class TelemetryService {
  private lastActivity = Date.now();
  private isIdle = false;
  private timer: number | null = null;
  private flushing = false;
  private queue: TelemetryEvent[] = loadQueue();

  private persist() {
    try {
      localStorage.setItem(QUEUE_KEY, JSON.stringify(this.queue.slice(-MAX_QUEUE)));
    } catch {
      /* ignore */
    }
  }

  start() {
    if (this.timer) return;
    const markActive = () => {
      const now = Date.now();
      if (this.isIdle) {
        this.isIdle = false;
        this.log({ eventType: 'idle_end' });
      }
      this.lastActivity = now;
    };

    window.addEventListener('mousemove', markActive, { passive: true });
    window.addEventListener('keydown', markActive, { passive: true });

    this.timer = window.setInterval(() => {
      if (!this.isIdle && Date.now() - this.lastActivity >= IDLE_THRESHOLD_MS) {
        this.isIdle = true;
        this.log({ eventType: 'idle_start' });
      }
      void this.flush();
    }, 15_000);
  }

  log(partial: Omit<TelemetryEvent, 'id' | 'deviceId' | 'createdAt'>) {
    const event: TelemetryEvent = {
      id: crypto.randomUUID(),
      deviceId: 'laptop_primary',
      createdAt: new Date().toISOString(),
      ...partial,
    };
    this.queue.push(event);
    if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE);
    this.persist();
  }

  async flush() {
    if (this.queue.length === 0 || !navigator.onLine) return;
    if (!isSignedIn()) return;

    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.slice(0, 50);
        await api.push({ telemetry: batch.map((e) => ({ id: e.id, data: e, createdAt: e.createdAt })) });
        this.queue.splice(0, batch.length);
        this.persist();
      }
    } catch {
      /* offline / server error: stays queued (persisted) for the next flush */
    } finally {
      this.flushing = false;
    }
  }
}

export const telemetryService = new TelemetryService();
