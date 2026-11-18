import { useCallback, useEffect, useRef, useState } from 'react';

const PFX = 'lifeapp.dash.';

export function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(PFX + key);
    return v == null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown) {
  try {
    localStorage.setItem(PFX + key, JSON.stringify(value));
  } catch {
    /* storage blocked or full: dashboard still works in memory */
  }
}

/** useState persisted to localStorage (debounced writes). */
export function usePersisted<T>(key: string, initial: T): [T, (v: T | ((p: T) => T)) => void] {
  const [val, setVal] = useState<T>(() => load(key, initial));
  const timer = useRef<number>(0);
  const latest = useRef(val);
  latest.current = val;
  useEffect(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => save(key, val), 250);
    return () => window.clearTimeout(timer.current);
  }, [key, val]);
  useEffect(() => () => save(key, latest.current), [key]);
  return [val, useCallback((v) => setVal(v), [])];
}
