import { useCallback, useEffect, useRef, useState } from 'react';

/** Hover with hysteresis: opens after `openDelay` of sustained hover, closes `closeDelay` after leave. */
export function useHoverIntent(openDelay: number, closeDelay: number) {
  const [active, setActive] = useState(false);
  const timer = useRef<number | null>(null);
  const clear = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  const onEnter = useCallback(() => {
    clear();
    timer.current = window.setTimeout(() => setActive(true), openDelay);
  }, [openDelay]);
  const onLeave = useCallback(() => {
    clear();
    timer.current = window.setTimeout(() => setActive(false), closeDelay);
  }, [closeDelay]);
  const force = useCallback((v: boolean) => {
    clear();
    setActive(v);
  }, []);
  useEffect(() => clear, []);
  return { active, onEnter, onLeave, force };
}
