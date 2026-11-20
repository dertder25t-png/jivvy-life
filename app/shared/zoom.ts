// Page zoom: the percentages browsers step through, and Chromium's logarithmic zoom level.
export const ZOOM_STEPS = [25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500] as const;
const BASE = Math.log(1.2);

/** Chromium zoom level for a percentage (100% = 0, each level is x1.2). */
export const levelFor = (percent: number) => Math.log(percent / 100) / BASE;
export const percentFor = (level: number) => Math.round(100 * Math.pow(1.2, level));

/** The next step above (dir 1) or below (dir -1) `percent`; stays at the ends. */
export function stepZoom(percent: number, dir: 1 | -1): number {
  if (dir > 0) return ZOOM_STEPS.find((s) => s > percent) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) if (ZOOM_STEPS[i] < percent) return ZOOM_STEPS[i];
  return ZOOM_STEPS[0];
}
