import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Search, CornerDownLeft } from 'lucide-react';
import { useWorkspaceStore } from '../store/workspaceStore';
import { decide, unitCalc, RouteDecision } from '../lib/router';

export const OPEN_OMNIBOX_EVENT = 'lifeapp:omnibox-open';

const CLS_STYLE: Record<RouteDecision['cls'], string> = {
  search: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  ask: 'bg-violet-500/15 text-violet-300 border-violet-500/30',
  deep: 'bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/30',
  url: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
};

function hostOf(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return 'web';
  }
}

interface OmniFormProps {
  variant: 'palette' | 'pill';
  autoFocus?: boolean;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  onDone: () => void;
}

// Shared input + route label + unit hint. Each mount keeps its own query string.
export const OmniForm: React.FC<OmniFormProps> = React.memo(({ variant, autoFocus, inputRef, onDone }) => {
  const openTab = useWorkspaceStore((s) => s.openTab);
  const [value, setValue] = useState('');
  const decision = useMemo(() => decide(value), [value]);
  const calc = useMemo(() => unitCalc(value), [value]);
  const canSubmit = !!decision && (decision.route === 'open-url' || decision.text.length > 0);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!decision || !canSubmit) return;
    if (decision.copy) void navigator.clipboard?.writeText(decision.text).catch(() => undefined);
    openTab({
      title: decision.route === 'open-url' ? hostOf(decision.url) : `${decision.label}: ${decision.text.slice(0, 40)}`,
      type: 'web',
      url: decision.url,
    });
    setValue('');
    onDone();
  };

  const inputClass =
    variant === 'pill'
      ? 'bg-transparent text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none w-full'
      : 'bg-transparent text-lg text-zinc-100 placeholder-zinc-500 focus:outline-none w-full';

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <Search className={variant === 'pill' ? 'w-4 h-4 text-zinc-500 shrink-0' : 'w-5 h-5 text-zinc-500 shrink-0'} />
        <input
          ref={inputRef}
          autoFocus={autoFocus}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Search, open an address, or ask Claude…  (!ask !gpt !g !deep !s)"
          className={inputClass}
          spellCheck={false}
          autoComplete="off"
        />
        <CornerDownLeft className="w-4 h-4 text-zinc-600 shrink-0" />
      </div>
      {(decision || calc) && (
        <div className="flex flex-wrap items-center gap-2 text-xs pl-8 min-h-[1.25rem]">
          {decision && (
            <span className={`px-2 py-0.5 rounded border ${CLS_STYLE[decision.cls]}`}>
              → {decision.label}
            </span>
          )}
          {decision && <span className="text-zinc-500 truncate">{decision.why}</span>}
          {calc && <span className="text-amber-300 font-medium">{calc}</span>}
          {decision?.hint && <span className="text-zinc-500 w-full">{decision.hint}</span>}
        </div>
      )}
    </form>
  );
});
OmniForm.displayName = 'OmniForm';

export const ZenOmnibox: React.FC = () => {
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const close = useCallback(() => setOpen(false), []);

  // Cmd/Ctrl+K toggles; Esc closes. Also opened by other components (e.g. the tab strip's "+").
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === 'Escape') {
        setOpen(false);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener(OPEN_OMNIBOX_EVENT, onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(OPEN_OMNIBOX_EVENT, onOpen);
    };
  }, []);

  // Native child webviews paint above the DOM: tell PaneContainer to hide them while the palette is open.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('lifeapp:overlay', { detail: { source: 'omnibox', open } }));
  }, [open]);

  // Keep focus in the palette input whenever it opens.
  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  return (
    <>
      {/* Command palette: always mounted, toggled with opacity/transform only. */}
      <div
        className={`fixed inset-0 z-50 flex items-start justify-center pt-[14vh] px-4 bg-black/50 transition-opacity duration-150 ${
          open ? 'opacity-100 backdrop-blur-sm' : 'opacity-0 pointer-events-none invisible'
        }`}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) close();
        }}
        aria-hidden={!open}
      >
        <div
          className={`w-full max-w-xl rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl shadow-black/60 p-4 transition-transform duration-150 ${
            open ? 'translate-y-0 scale-100' : '-translate-y-2 scale-[0.98]'
          }`}
        >
          <OmniForm variant="palette" inputRef={inputRef} onDone={close} />
          <div className="mt-3 pt-2 border-t border-zinc-800 flex justify-between text-[10px] text-zinc-500">
            <span>Enter to open · Esc to close</span>
            <span>⌘/Ctrl + K</span>
          </div>
        </div>
      </div>
    </>
  );
};
