// Layout constants and page geometry shared by the Electron main process (which places the
// page WebContentsViews) and the renderer (which draws the chrome around them). Both sides
// compute from the same numbers, so the page and the chrome can never disagree.

export type LayoutMode = 'left-vertical' | 'compact-rail' | 'classic-top' | 'zen';
export type ZenBarPosition = 'left' | 'top' | 'bottom';

export const LAYOUT = {
  /** The old drag header (h-8). The window has a native title bar and the header drew nothing, so
   *  no layout reserves it any more; kept for the saved layout shape. */
  TOP_BAR_H: 32,
  /** Classic top tab strip (h-10). */
  TAB_BAR_H: 40,
  /** Address bar (h-10). */
  ADDRESS_BAR_H: 40,
  /** Hover strips drawn in the base view: Zen edges (h-1.5 / w-1.5). */
  STRIP: 6,
  /** Invisible hover strip along the top edge (its own view over the page) that floats the
   *  auto-hidden address bar. Reserves no space. */
  EDGE_H: 4,
  /** Pinned sidebar (w-64). Also the width of the hover-expanded rail. */
  SIDEBAR_W: 256,
  /** Collapsed compact rail (w-12). */
  RAIL_W: 48,
  /** Split view: 1px divider between the panes (divide-x). */
  SPLIT_DIVIDER: 1,
  SPLIT_RATIO: 0.5,
  /** Persistent layout transitions (sidebar <-> rail). Main animates the page, CSS mirrors it. */
  ANIM_MS: 180,
  EASE: [0.2, 0, 0, 1] as const,
  /** Hover intent before the rail / Zen bars / address bar float out over the page. */
  HOVER_OPEN_MS: 150,
  RAIL_OPEN_MS: 180,
  HOVER_CLOSE_MS: 300,
};

export const EASE_CSS = `cubic-bezier(${LAYOUT.EASE.join(', ')})`;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutInput {
  width: number;
  height: number;
  layoutMode: LayoutMode;
  showTopBar: boolean;
  autoHideAddressBar: boolean;
  zenBarPosition: ZenBarPosition;
  split: boolean;
}

export interface Insets {
  top: number;
  left: number;
  bottom: number;
  /** Whether a sidebar column is shown at all (its width is `left`). */
  sidebar: boolean;
}

/** Space the chrome takes on each edge for a layout; the pages get the rest. */
export function chromeInsets(i: Omit<LayoutInput, 'width' | 'height' | 'split'>): Insets {
  // Auto-hidden address bar: nothing is drawn in the base view and no space is reserved; the bar
  // floats over the page (overlay view), revealed by the top-edge hover strip or Ctrl+L.
  const addr = i.autoHideAddressBar ? 0 : LAYOUT.ADDRESS_BAR_H;
  if (i.layoutMode === 'zen') {
    if (i.zenBarPosition === 'top') return { top: LAYOUT.STRIP, left: 0, bottom: 0, sidebar: false };
    if (i.zenBarPosition === 'bottom') return { top: 0, left: 0, bottom: LAYOUT.STRIP, sidebar: false };
    return { top: addr, left: LAYOUT.STRIP, bottom: 0, sidebar: true };
  }
  // The top bar (`showTopBar`) is an empty drag header: it draws nothing, so it reserves nothing.
  // The classic layout's tab strip shows real tabs, so it keeps its space.
  let top = 0;
  if (i.layoutMode === 'classic-top') top += LAYOUT.TAB_BAR_H;
  top += addr;
  const left = i.layoutMode === 'left-vertical' ? LAYOUT.SIDEBAR_W : i.layoutMode === 'compact-rail' ? LAYOUT.RAIL_W : 0;
  return { top, left, bottom: 0, sidebar: i.layoutMode !== 'classic-top' };
}

/** Where the address bar sits (window DIPs) when it floats over the page. */
export function addressBarRect(i: LayoutInput, leftOverride?: number): Rect {
  const left = Math.round(leftOverride ?? chromeInsets(i).left);
  const top = i.layoutMode === 'classic-top' ? LAYOUT.TAB_BAR_H : 0;
  return { x: left, y: top, width: Math.max(1, i.width - left), height: LAYOUT.ADDRESS_BAR_H };
}

/** The hover strip that reveals the auto-hidden address bar, or null when there is none
 *  (address bar always shown, or a Zen layout whose bar is not the address bar). */
export function edgeStripRect(i: LayoutInput): Rect | null {
  if (!i.autoHideAddressBar) return null;
  if (i.layoutMode === 'zen' && i.zenBarPosition !== 'left') return null;
  const r = addressBarRect(i);
  return { x: r.x, y: r.y, width: r.width, height: LAYOUT.EDGE_H };
}

/** Widths of the two split panes for a content width (first pane, second pane incl. divider). */
export function splitWidths(width: number): [number, number] {
  const first = Math.floor((width - LAYOUT.SPLIT_DIVIDER) * LAYOUT.SPLIT_RATIO);
  return [first, width - first];
}

/** Page rects in window DIPs. `leftOverride` lets main animate the sidebar edge. */
export function pageRects(i: LayoutInput, leftOverride?: number): { primary: Rect; secondary: Rect | null } {
  const ins = chromeInsets(i);
  const left = Math.round(leftOverride ?? ins.left);
  const area: Rect = {
    x: left,
    y: ins.top,
    width: Math.max(1, i.width - left),
    height: Math.max(1, i.height - ins.top - ins.bottom),
  };
  if (!i.split) return { primary: area, secondary: null };
  const [a, b] = splitWidths(area.width);
  return {
    primary: { ...area, width: Math.max(1, a) },
    secondary: { ...area, x: area.x + a + LAYOUT.SPLIT_DIVIDER, width: Math.max(1, b - LAYOUT.SPLIT_DIVIDER) },
  };
}

/** CSS cubic-bezier evaluated in JS, so main's animation follows the exact CSS curve. */
export function cubicBezier(p1x: number, p1y: number, p2x: number, p2y: number) {
  const cx = 3 * p1x, bx = 3 * (p2x - p1x) - cx, ax = 1 - cx - bx;
  const cy = 3 * p1y, by = 3 * (p2y - p1y) - cy, ay = 1 - cy - by;
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sy = (t: number) => ((ay * t + by) * t + cy) * t;
  const dx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const err = sx(t) - x;
      if (Math.abs(err) < 1e-5) break;
      const d = dx(t);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    let lo = 0, hi = 1;
    if (Math.abs(sx(t) - x) > 1e-4) {
      t = x;
      for (let i = 0; i < 30; i++) {
        if (sx(t) < x) lo = t;
        else hi = t;
        t = (lo + hi) / 2;
      }
    }
    return sy(t);
  };
}
