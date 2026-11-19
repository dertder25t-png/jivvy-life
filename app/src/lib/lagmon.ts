// Opt-in frame-gap monitor (dev builds, ?lagmon in the URL, or the self-test calling
// window.__jivvyLagStart()). A requestAnimationFrame loop records the gap between frames and keeps
// the worst ones; it costs nothing unless started. Only gaps while the page is visible count.
export interface LagStats {
  maxGap: number;
  frames: number;
  gaps: Array<{ at: number; ms: number }>;
}
declare global {
  interface Window {
    __jivvyLagStart?: () => void;
    __jivvyLagReset?: () => void;
    __jivvyLag?: () => LagStats;
  }
}

export function installLagMonitor() {
  let running = false;
  let last = 0;
  let maxGap = 0;
  let frames = 0;
  let gaps: LagStats['gaps'] = [];
  const tick = (t: number) => {
    if (last && document.visibilityState === 'visible') {
      const g = t - last;
      frames++;
      if (g > maxGap) maxGap = g;
      if (g > 100) {
        gaps.push({ at: Math.round(performance.now()), ms: Math.round(g) });
        if (gaps.length > 50) gaps.shift();
        console.warn(`[lagmon] frame gap ${Math.round(g)} ms`);
      }
    }
    last = t;
    requestAnimationFrame(tick);
  };
  window.__jivvyLagStart = () => {
    if (running) return;
    running = true;
    last = 0;
    requestAnimationFrame(tick);
  };
  window.__jivvyLagReset = () => {
    maxGap = 0;
    frames = 0;
    gaps = [];
    last = 0;
  };
  window.__jivvyLag = () => ({ maxGap, frames, gaps });
  if (import.meta.env.DEV || new URLSearchParams(location.search).has('lagmon')) window.__jivvyLagStart();
}
