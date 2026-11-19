// The contract between the Electron main process and the two UI views (base + overlay).
// `window.jivvy` (preload) implements JivvyApi; main validates everything that comes in.

import type { Action, PersistedState } from './state';
import type { Rect } from './layout';
import type { TypedInput, Visit } from './history-types';

export interface TabRuntime {
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  audible: boolean;
  muted: boolean;
  favicon: string | null;
  /** Webcontents destroyed to save memory; the record (url/title/favicon/scroll) is kept. */
  discarded: boolean;
}

/** Things that float over web pages. Rendered by the overlay view, positioned by main. */
export type OverlaySpec =
  | { kind: 'menu'; anchor: Rect; placement: 'up' | 'down' }
  | { kind: 'tabmenu'; tabId: string; x: number; y: number }
  | { kind: 'confirm'; title: string; body: string; confirmLabel: string; action: Action }
  | { kind: 'omnibox' }
  | { kind: 'settings' }
  | { kind: 'import' }
  | { kind: 'rail'; anchor: Rect }
  | { kind: 'zenbar'; position: 'top' | 'bottom'; anchor: Rect }
  | { kind: 'addressbar'; anchor: Rect; focus?: boolean };

export type OverlayKind = OverlaySpec['kind'];
/** Hover surfaces never take focus and close when the pointer leaves them. */
export const HOVER_KINDS: OverlayKind[] = ['rail', 'zenbar', 'addressbar'];
/** Popups close when the overlay loses focus (click anywhere else), like native menus. */
export const BLUR_KINDS: OverlayKind[] = ['menu', 'tabmenu', 'rail', 'zenbar', 'addressbar'];

export interface RuntimeState {
  tabs: Record<string, TabRuntime>;
  fullscreenTabId: string | null;
  overlay: OverlaySpec | null;
  blocking: { ready: boolean; rules: number };
}

export interface StatePatch {
  persist?: Partial<PersistedState>;
  runtime?: Partial<RuntimeState>;
}

export interface InitPayload {
  state: PersistedState;
  runtime: RuntimeState;
}

export type UiEvent = { type: 'edit-folder'; id: string } | { type: 'focus-address' } | { type: 'edge-hover' };

export interface OverlayMessage {
  spec: OverlaySpec | null;
  seq: number;
  /** Window content size, so the overlay can lay out in window coordinates. */
  win: { width: number; height: number };
}

/** One row of `history:search`: a page the user has visited, with how often and when last. */
export interface HistoryHit {
  url: string;
  host: string;
  title: string;
  visits: number;
  lastT: number;
}

export interface ImportStatus {
  state: 'idle' | 'running' | 'done' | 'error';
  imported: number;
  skipped: number;
  error?: string;
  /** Epoch ms when the last import finished. */
  at?: number;
}

export type HistoryClearRange = 'hour' | 'day' | 'all';

export type NavAction = 'back' | 'forward' | 'reload' | 'stop';

export interface JivvyApi {
  init(): Promise<InitPayload>;
  dispatch(a: Action): void;
  onPatch(cb: (p: StatePatch) => void): () => void;
  tabNav(tabId: string, action: NavAction): void;
  setMuted(tabId: string, muted: boolean): void;
  overlayOpen(spec: OverlaySpec): void;
  overlayClose(seq?: number): void;
  /** Overlay finished rendering `seq`: show it at `rect` (window DIPs), or full window when null. */
  overlayReady(seq: number, rect: Rect | null): void;
  onOverlay(cb: (m: OverlayMessage) => void): () => void;
  emit(ev: UiEvent): void;
  onEvent(cb: (ev: UiEvent) => void): () => void;
  /** Local browsing history (main-process sqlite). All of it is private to this machine. */
  historyTyped(i: Omit<TypedInput, 't'>): void;
  historySearch(text: string, limit?: number): Promise<HistoryHit[]>;
  historyRecent(limit?: number): Promise<Visit[]>;
  historyClear(range: HistoryClearRange): Promise<number>;
  /** Opt-in, one shot: copy Firefox's history into the local store. Settings button calls this. */
  historyImportFirefox(): Promise<ImportStatus>;
  historyImportStatus(): Promise<ImportStatus>;
  /** Native commands (Tauri `invoke` equivalents). Unported ones reject with "not yet available". */
  invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T>;
}

export const CH = {
  init: 'jivvy:init',
  dispatch: 'jivvy:dispatch',
  patch: 'jivvy:patch',
  tabNav: 'jivvy:tab-nav',
  setMuted: 'jivvy:set-muted',
  overlayOpen: 'jivvy:overlay-open',
  overlayClose: 'jivvy:overlay-close',
  overlayReady: 'jivvy:overlay-ready',
  overlay: 'jivvy:overlay',
  emit: 'jivvy:emit',
  event: 'jivvy:event',
  invoke: 'jivvy:invoke',
  historyTyped: 'history:typed',
  historySearch: 'history:search',
  historyRecent: 'history:recent',
  historyClear: 'history:clear',
  historyImportFirefox: 'history:importFirefox',
  historyImportStatus: 'history:importStatus',
} as const;
