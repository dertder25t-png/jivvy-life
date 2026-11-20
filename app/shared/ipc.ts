// The contract between the Electron main process and the two UI views (base + overlay).
// `window.jivvy` (preload) implements JivvyApi; main validates everything that comes in.

import type { Action, PersistedState } from './state';
import type { Rect } from './layout';
import type { TypedInput, UiSnapshot, Visit } from './history-types';
import type { BenchResult } from './lifeboard/bench';
import type { EvalLine } from './lifeboard/evallog';

export interface TabRuntime {
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  audible: boolean;
  muted: boolean;
  favicon: string | null;
  /** Asleep: webcontents destroyed to save memory; the record (url/title/favicon/scroll/history) is kept. */
  sleeping: boolean;
}

/** Live numbers for Settings -> Memory. */
export interface MemoryStatus {
  /** Sum of working sets across all app processes (MB). */
  totalMB: number;
  awake: number;
  sleeping: number;
  /** System MemAvailable (MB), or null when unreadable (not Linux). */
  availableMB: number | null;
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
  | { kind: 'addressbar'; anchor: Rect; focus?: boolean }
  /** Address-bar suggestion dropdown for the base view's bar; never takes focus. Clicks come back as a `suggest-pick` event. */
  | { kind: 'suggest'; anchor: Rect; items: SuggestItem[]; selected: number }
  /** Downloads list, a popup under the downloads button (`anchor.x` is the panel's right edge, `anchor.y` its top). */
  | { kind: 'downloads'; anchor: Rect }
  /**
   * The always-on-top-of-the-page strip in the page area's top-right corner: find bar, zoom
   * indicator, permission prompt and toast, all drawn from `RuntimeState.hud`. Opened and closed
   * by main alone; any other overlay temporarily replaces it. `anchor` is the page area.
   */
  | { kind: 'hud'; anchor: Rect };

export interface SuggestItem {
  url: string;
  title: string;
  host: string;
}

export type OverlayKind = OverlaySpec['kind'];
/** Hover surfaces never take focus and close when the pointer leaves them. */
export const HOVER_KINDS: OverlayKind[] = ['rail', 'zenbar', 'addressbar', 'suggest'];
/** Popups close when the overlay loses focus (click anywhere else), like native menus. */
export const BLUR_KINDS: OverlayKind[] = ['menu', 'tabmenu', 'rail', 'zenbar', 'addressbar', 'downloads'];

export type DownloadState = 'progressing' | 'done' | 'failed' | 'cancelled';

export interface DownloadInfo {
  id: string;
  name: string;
  /** Where it came from (host only; the full URL may carry secrets). */
  host: string;
  received: number;
  /** 0 = unknown. */
  total: number;
  /** Bytes per second, smoothed. */
  speed: number;
  state: DownloadState;
  startedAt: number;
}

export interface PermPrompt {
  id: number;
  origin: string;
  host: string;
  /** "wants to use your camera", ready to follow the host. */
  text: string;
  /** Seconds until it is denied on its own. */
  expiresAt: number;
}

export interface HudState {
  find: { text: string; active: number; total: number; tabId: string } | null;
  zoom: { percent: number; host: string; seq: number } | null;
  toast: { id: number; text: string; downloadId?: string } | null;
  perm: PermPrompt | null;
}

export const EMPTY_HUD: HudState = { find: null, zoom: null, toast: null, perm: null };

export interface RuntimeState {
  tabs: Record<string, TabRuntime>;
  fullscreenTabId: string | null;
  overlay: OverlaySpec | null;
  blocking: { ready: boolean; rules: number };
  /** Newest first, at most 50. */
  downloads: DownloadInfo[];
  hud: HudState;
}

export interface StatePatch {
  persist?: Partial<PersistedState>;
  runtime?: Partial<RuntimeState>;
}

export interface InitPayload {
  state: PersistedState;
  runtime: RuntimeState;
}

export type UiEvent =
  | { type: 'edit-folder'; id: string }
  | { type: 'focus-address' }
  | { type: 'edge-hover' }
  | { type: 'suggest-pick'; index: number }
  /** Main -> overlay: Ctrl+F again, put the caret back in the find box. */
  | { type: 'focus-find' };

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
  /** Throttled (<= 4/s) push of import progress while an import runs. */
  onHistoryImportStatus(cb: (s: ImportStatus) => void): () => void;
  /** The latest nightly prediction snapshot (null until the first training run). */
  predictions(): Promise<UiSnapshot | null>;
  /** Fires whenever a new snapshot is written (or history was cleared and the snapshot rebuilt). */
  onPredictions(cb: (s: UiSnapshot | null) => void): () => void;
  /** Retrain now (worker thread). Resolves with the new snapshot, or null if training failed. */
  predictionsTrain(): Promise<UiSnapshot | null>;
  /** Run the search benchmark on the live history (worker thread). Null on failure. */
  predictionsBench(): Promise<BenchResult | null>;
  /** Recent nightly self-evaluation lines (oldest first), for the Settings sparkline. */
  predictionsEvalLog(): Promise<EvalLine[]>;
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
  predictions: 'predictions:get',
  predictionsUpdated: 'predictions:updated',
  predictionsTrain: 'predictions:train',
  predictionsBench: 'predictions:bench',
  predictionsEvalLog: 'predictions:evalLog',
} as const;
