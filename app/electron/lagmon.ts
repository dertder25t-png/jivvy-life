// Opt-in main-process event-loop lag monitor (JIVVY_LAGMON=1, and always on in the self-test).
// A 50 ms interval records how late it fires; stalls over 100 ms are logged together with the
// operations that were running (`lagOp`). Zero cost when not started.
const STALL_LOG_MS = 100;
const TICK = 50;

let timer: NodeJS.Timeout | null = null;
let expected = 0;
let maxStall = 0;
let stalls: Array<{ ms: number; ops: string }> = [];
const ops = new Map<string, number>();

/** Mark an operation as running until the returned function is called (label shows up in stall logs). */
export function lagOp(label: string): () => void {
  ops.set(label, (ops.get(label) ?? 0) + 1);
  return () => {
    const n = (ops.get(label) ?? 1) - 1;
    if (n <= 0) ops.delete(label);
    else ops.set(label, n);
  };
}

export function startLagMon() {
  if (timer) return;
  expected = performance.now() + TICK;
  timer = setInterval(() => {
    const now = performance.now();
    const drift = Math.max(0, now - expected);
    expected = now + TICK;
    if (drift > maxStall) maxStall = drift;
    if (drift > STALL_LOG_MS) {
      const o = [...ops.keys()].join('+') || 'idle';
      stalls.push({ ms: Math.round(drift), ops: o });
      if (stalls.length > 100) stalls.shift();
      console.error(`[lagmon] main stalled ${Math.round(drift)} ms during: ${o}`);
    }
  }, TICK);
  timer.unref();
}

export function lagStats() {
  return { maxStall: Math.round(maxStall), stalls: [...stalls] };
}

export function resetLag() {
  maxStall = 0;
  stalls = [];
  expected = performance.now() + TICK;
}
