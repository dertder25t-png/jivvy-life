import { jivvy } from '../platform';
/**
 * Jivvy Life API client (Encore backend). Thin fetch wrapper: base URL + bearer token,
 * ~10s timeouts, typed errors. A 401 clears the session and marks the app signed out.
 *
 * ALPHA NOTE: the session token is stored in localStorage ('jivvy_session'). Fine for alpha;
 * move to the OS keyring (Electron safeStorage) before wider release. The password is never persisted.
 */
export const DEFAULT_API_BASE = 'https://staging-jivvy-life-api-ei5i.encr.app';
const LEGACY_LOCAL_BASE = 'http://127.0.0.1:4000';
const BASE_KEY = 'jivvy_api_base';
const SESSION_KEY = 'jivvy_session';
const TIMEOUT_MS = 10_000;

/** Fired when base URL or session changes (sign in/out, 401). */
export const API_CONFIG_EVENT = 'jivvy:api-config';

export interface Session {
  token: string;
  userId: string;
  email: string;
}
export interface SyncRow<T = unknown> {
  id: string;
  data: T;
  updatedAt: string;
  deleted?: boolean;
}
export interface PushBody {
  workspaces?: SyncRow[];
  notes?: SyncRow[];
  preferences?: { data: unknown; updatedAt: string };
  telemetry?: { id: string; data: unknown; createdAt: string }[];
}
export interface PushResult {
  accepted: { workspaces: string[]; notes: string[] };
  serverTime: string;
}
export interface PullResult {
  workspaces: SyncRow[];
  notes: SyncRow[];
  preferences: { data: unknown; updatedAt: string } | null;
  serverTime: string;
}

export type ApiErrorKind = 'network' | 'timeout' | 'unauthorized' | 'http';
export class ApiError extends Error {
  constructor(public kind: ApiErrorKind, message: string, public status?: number) {
    super(message);
    this.name = 'ApiError';
  }
}

function emit() {
  window.dispatchEvent(new Event(API_CONFIG_EVENT));
}

export function getApiBase(): string {
  try {
    const stored = localStorage.getItem(BASE_KEY);
    const base = stored && stored.replace(/\/+$/, '') !== LEGACY_LOCAL_BASE ? stored : DEFAULT_API_BASE;
    return base.replace(/\/+$/, '');
  } catch {
    return DEFAULT_API_BASE;
  }
}
export function setApiBase(url: string) {
  const v = url.trim().replace(/\/+$/, '');
  try {
    if (v && v !== DEFAULT_API_BASE) localStorage.setItem(BASE_KEY, v);
    else localStorage.removeItem(BASE_KEY);
  } catch {
    /* ignore */
  }
  emit();
}

export function getSession(): Session | null {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null') as Session | null;
    return s && s.token ? s : null;
  } catch {
    return null;
  }
}
function setSession(s: Session | null) {
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
  emit();
}
/** Sync only runs with a session; with none the app is purely local. */
export const isSignedIn = () => !!getSession();

async function request<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
  const session = auth ? getSession() : null;
  if (auth && !session) throw new ApiError('unauthorized', 'Not signed in', 401);
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${getApiBase()}${path}`, {
      method,
      signal: ctrl.signal,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(session ? { Authorization: `Bearer ${session.token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const j = await res.json();
        if (j?.message) msg = String(j.message);
      } catch {
        /* non-JSON error body */
      }
      if (res.status === 401 && auth) {
        setSession(null);
        throw new ApiError('unauthorized', 'Session expired. Please log in again.', 401);
      }
      throw new ApiError(res.status === 401 ? 'unauthorized' : 'http', msg, res.status);
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (e instanceof DOMException && e.name === 'AbortError') throw new ApiError('timeout', 'Request timed out');
    throw new ApiError('network', e instanceof Error ? e.message : 'Network error');
  } finally {
    window.clearTimeout(timer);
  }
}

export const api = {
  async signup(email: string, password: string): Promise<Session> {
    const r = await request<Session>('POST', '/auth/signup', { email, password }, false);
    const s = { token: r.token, userId: r.userId, email: r.email };
    setSession(s);
    return s;
  },
  async login(email: string, password: string): Promise<Session> {
    const r = await request<Session>('POST', '/auth/login', { email, password }, false);
    const s = { token: r.token, userId: r.userId, email: r.email };
    setSession(s);
    return s;
  },
  async loginWithGoogle(): Promise<Session> {
    if (!jivvy) throw new Error('Google sign-in needs the desktop app.');
    const { code, codeVerifier, redirectUri } = await jivvy.authGoogle();
    const r = await request<Session>('POST', '/auth/google', { code, codeVerifier, redirectUri }, false);
    const s = { token: r.token, userId: r.userId, email: r.email };
    setSession(s);
    return s;
  },
  async logout() {
    try {
      await request<void>('POST', '/auth/logout');
    } catch {
      /* clear locally regardless */
    }
    setSession(null);
  },
  me: () => request<{ userId: string; email: string }>('GET', '/auth/me'),
  push: (body: PushBody) => request<PushResult>('POST', '/sync/push', body),
  pull: (since?: string) =>
    request<PullResult>('GET', `/sync/pull${since ? `?since=${encodeURIComponent(since)}` : ''}`),
};
