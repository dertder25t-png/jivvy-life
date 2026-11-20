// Which shell the UI runs in, and the few platform calls components need.
// - Electron: `window.jivvy` (preload). Two UI views: the base view (chrome under the pages) and
//   the overlay view (`#overlay`, transparent, floats menus/modals/hover UI over the pages).
// - Plain browser (vite dev without a shell): iframes, no native features.
import type { JivvyApi, OverlaySpec } from '../../shared/ipc';

declare global {
  interface Window {
    jivvy?: JivvyApi;
  }
}

export const jivvy: JivvyApi | undefined = typeof window !== 'undefined' ? window.jivvy : undefined;
export const isElectron = !!jivvy;
/** A native shell is present (pages are native views, blocking etc. available). */
export const isNative = isElectron;
export const role: 'base' | 'overlay' | 'edge' =
  typeof location !== 'undefined' && (location.hash === '#overlay' || location.hash === '#edge') ? (location.hash.slice(1) as 'overlay' | 'edge') : 'base';
/** Running inside the Electron top-edge hover strip view (reveals the auto-hidden address bar). */
export const isEdgeRole = isElectron && role === 'edge';
/** Running inside the Electron overlay view. */
export const isOverlayRole = isElectron && role === 'overlay';
/** Electron base view: floating UI must be sent to the overlay view instead of drawn inline. */
export const floatsToOverlay = isElectron && role === 'base';

export function openOverlay(spec: OverlaySpec) {
  jivvy?.overlayOpen(spec);
}
export function closeOverlay() {
  jivvy?.overlayClose();
}

/** Native command: Electron main. Rejects when there is no native shell. */
export function nativeInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (jivvy) return jivvy.invoke<T>(cmd, args);
  return Promise.reject(new Error('Not available outside the desktop app'));
}

// ---- Overlay geometry -----------------------------------------------------------------------
// In the overlay view, everything is drawn in a layer that uses window coordinates; main shrinks
// the view to the area the layer actually uses and the layer is shifted to match.
let overlayWin = { width: 0, height: 0 };
export function setOverlayWindowSize(w: { width: number; height: number }) {
  overlayWin = w;
}
/** The app window's size (the overlay view itself may be smaller than the window). */
export function viewport(): { width: number; height: number } {
  return isOverlayRole && overlayWin.width ? overlayWin : { width: window.innerWidth, height: window.innerHeight };
}
/** Where popups portal to: the window-coordinate layer in the overlay view, else <body>. */
export function portalTarget(): HTMLElement {
  return (isOverlayRole && document.getElementById('overlay-layer')) || document.body;
}
