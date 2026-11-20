// Site permissions for the page session. Camera, microphone, location, notifications, clipboard
// read and MIDI ask the user (an overlay prompt, Allow / Block, optionally remembered per origin
// in prefs). Fullscreen, clipboard write and pointer lock are always fine. Everything else is
// denied. The check handler answers from remembered decisions only and never prompts, so it
// always agrees with what the request handler would have said without asking.
import type { Session, WebContents } from 'electron';
import type { PermPrompt } from '../shared/ipc';
import type { PermDecision, PersistedState, PromptPermission, SitePermissions } from '../shared/state';

const ALWAYS = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock']);
const PLAIN: Record<string, PromptPermission> = {
  geolocation: 'geolocation',
  notifications: 'notifications',
  'clipboard-read': 'clipboard-read',
  midi: 'midi',
};
const ACTION: Record<PromptPermission, string> = {
  camera: 'use your camera',
  microphone: 'use your microphone',
  geolocation: 'know your location',
  notifications: 'show notifications',
  'clipboard-read': 'read your clipboard',
  midi: 'use your MIDI devices',
};

export const PROMPT_TIMEOUT_MS = 60_000;

/** Which prompt-able permissions a Chromium permission + details stands for; null = never allowed. */
export function kindsFor(permission: string, mediaTypes?: readonly string[]): PromptPermission[] | null {
  if (permission === 'media') {
    const k: PromptPermission[] = [];
    // Chromium's check handler reports 'unknown' when it cannot tell which: need both then.
    const t = mediaTypes && mediaTypes.length ? mediaTypes : ['video', 'audio'];
    if (t.includes('video') || t.includes('unknown')) k.push('camera');
    if (t.includes('audio') || t.includes('unknown')) k.push('microphone');
    return k.length ? k : null;
  }
  const one = PLAIN[permission];
  return one ? [one] : null;
}

export function originOf(url: string): string {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : '';
  } catch {
    return '';
  }
}

export function promptText(host: string, kinds: PromptPermission[]): string {
  const parts = kinds.map((k) => ACTION[k]);
  // "use your camera and use your microphone" reads badly: join as "use your camera and microphone".
  if (parts.length === 2 && parts.every((p) => p.startsWith('use your '))) return `${host} wants to use your ${parts.map((p) => p.slice(9)).join(' and ')}`;
  return `${host} wants to ${parts.join(' and ')}`;
}

interface Pending {
  prompt: PermPrompt;
  kinds: PromptPermission[];
  callbacks: Array<(allow: boolean) => void>;
  timer: NodeJS.Timeout;
}

export interface PermissionsHost {
  state(): PersistedState;
  remember(origin: string, kind: PromptPermission, value: PermDecision): void;
  /** The prompt to show now (the head of the queue) or null. */
  show(p: PermPrompt | null): void;
}

export class Permissions {
  timeoutMs = PROMPT_TIMEOUT_MS;
  private queue: Pending[] = [];
  private nextId = 1;

  constructor(private host: PermissionsHost) {}

  attach(ses: Session) {
    ses.setPermissionRequestHandler((wc, permission, cb, details) => {
      const d = details as { requestingUrl?: string; mediaTypes?: string[] };
      this.request(wc, permission, d.requestingUrl || wc.getURL(), d.mediaTypes, cb);
    });
    ses.setPermissionCheckHandler((_wc, permission, origin, details) => {
      const d = details as { mediaType?: string; requestingUrl?: string };
      return this.check(permission, origin || originOf(d.requestingUrl ?? ''), d.mediaType ? [d.mediaType] : undefined);
    });
    ses.setDevicePermissionHandler(() => false);
  }

  private decisions(origin: string): SitePermissions[string] {
    return this.host.state().sitePermissions[origin] ?? {};
  }

  /** Remembered answers only: true = every needed permission was allowed before. */
  check(permission: string, origin: string, mediaTypes?: readonly string[]): boolean {
    if (ALWAYS.has(permission)) return true;
    const kinds = kindsFor(permission, mediaTypes);
    if (!kinds || !originOf(origin)) return false;
    const d = this.decisions(originOf(origin));
    return kinds.every((k) => d[k] === 'allow');
  }

  request(_wc: WebContents | null, permission: string, url: string, mediaTypes: readonly string[] | undefined, cb: (allow: boolean) => void) {
    if (ALWAYS.has(permission)) return cb(true);
    const kinds = kindsFor(permission, mediaTypes);
    const origin = originOf(url);
    if (!kinds || !origin) return cb(false);
    const d = this.decisions(origin);
    if (kinds.some((k) => d[k] === 'block')) return cb(false);
    const undecided = kinds.filter((k) => d[k] !== 'allow');
    if (!undecided.length) return cb(true);
    // The same question already waiting (a page asking twice): answer both together.
    const dup = this.queue.find((p) => p.prompt.origin === origin && p.kinds.join() === undecided.join());
    if (dup) return void dup.callbacks.push(cb);
    const id = this.nextId++;
    let host = origin;
    try {
      host = new URL(origin).host;
    } catch {
      /* keep origin */
    }
    const prompt: PermPrompt = { id, origin, host, text: promptText(host, undecided), expiresAt: Date.now() + this.timeoutMs };
    const timer = setTimeout(() => this.answer(id, false, false), this.timeoutMs);
    this.queue.push({ prompt, kinds: undecided, callbacks: [cb], timer });
    if (this.queue.length === 1) this.host.show(prompt);
  }

  /** The user's answer (or the timeout's). Unknown ids are ignored. */
  answer(id: number, allow: boolean, remember: boolean): boolean {
    const i = this.queue.findIndex((p) => p.prompt.id === id);
    if (i < 0) return false;
    const [p] = this.queue.splice(i, 1);
    clearTimeout(p.timer);
    if (remember) for (const k of p.kinds) this.host.remember(p.prompt.origin, k, allow ? 'allow' : 'block');
    for (const cb of p.callbacks) {
      try {
        cb(allow);
      } catch {
        /* the page is gone */
      }
    }
    this.host.show(this.queue[0]?.prompt ?? null);
    return true;
  }

  pending(): number {
    return this.queue.length;
  }

  stop() {
    for (const p of this.queue) clearTimeout(p.timer);
    this.queue = [];
  }
}
