import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Search, CornerDownLeft } from 'lucide-react';
import { useWorkspaceStore } from '../store/workspaceStore';
import { setOverlay } from '../lib/overlay';
import { isElectron, isOverlayRole, openOverlay } from '../platform';
import { destination, recordTyped, route, suggest, usePredictions } from '../lib/predictions';
import { SuggestRows } from './AddressBar';

export const OPEN_OMNIBOX_EVENT = 'lifeapp:omnibox-open';

const CLS_STYLE: Record<string, string> = {
  code: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
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
const OmniForm: React.FC<OmniFormProps> = React.memo(({ variant, autoFocus, inputRef, onDone }) => {
  const openTab = useWorkspaceStore((s) => s.openTab);
  const [value, setValue] = useState('');
  const snap = usePredictions();
  const [sel, setSel] = useState(-1);
  const decision = useMemo(() => route(value, snap), [value, snap]);
  const calc = decision?.calc ?? null;
  const rows = useMemo(
    () => (value.trim() && !/^\s*!/.test(value) ? suggest(value, snap).suggestions.map((x) => ({ url: x.url, title: x.title, host: x.host })) : []),
    [value, snap]
  );
  const canSubmit = !!decision && (decision.route === 'open-url' || decision.text.length > 0);

  const finish = (url: string, title: string) => {
    openTab({ title, type: 'web', url });
    setValue('');
    setSel(-1);
    onDone();
  };
  const pickRow = (i: number) => {
    const r = rows[i];
    if (!r) return;
    recordTyped({ text: value, url: r.url, shownUrl: r.url, accepted: true });
    finish(r.url, r.title || r.host);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (sel >= 0 && rows[sel]) return pickRow(sel);
    if (!decision || !canSubmit) return;
    if (decision.copy) void navigator.clipboard?.writeText(decision.text).catch(() => undefined);
    const dest = destination(decision);
    recordTyped({ text: value, url: decision.route === 'open-url' ? dest.url : '', shownUrl: rows[0]?.url, accepted: false });
    finish(dest.url, decision.route === 'open-url' ? hostOf(dest.url) : `${dest.label}: ${decision.text.slice(0, 40)}`);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && rows.length) {
      e.preventDefault();
      setSel((i) => (e.key === 'ArrowDown' ? Math.min(rows.length - 1, i + 1) : Math.max(-1, i - 1)));
    }
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
          onChange={(e) => {
            setValue(e.target.value);
            setSel(-1);
          }}
          onKeyDown={onKeyDown}
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
            <span className={`px-2 py-0.5 rounded border ${CLS_STYLE[decision.route === 'open-url' ? 'url' : decision.cls ?? 'search']}`}>
              → {decision.label}
            </span>
          )}
          {decision && <span className="text-zinc-500 truncate">{decision.why}</span>}
          {calc && <span className="text-amber-300 font-medium">{calc}</span>}
          {decision?.hint && <span className="text-zinc-500 w-full">{decision.hint}</span>}
        </div>
      )}
      {rows.length > 0 && (
        <div className="pl-8">
          <SuggestRows items={rows} selected={sel} onPick={pickRow} />
        </div>
      )}
    </form>
  );
});
OmniForm.displayName = 'OmniForm';

/** The command palette (Cmd/Ctrl+K). Electron draws it in the overlay view, over the page. */
export const OmniboxPalette: React.FC<{ open: boolean; onClose: () => void; inputRef?: React.RefObject<HTMLInputElement | null> }> = ({
  open,
  onClose,
  inputRef,
}) => {
  const ownRef = useRef<HTMLInputElement | null>(null);
  const ref = inputRef ?? ownRef;
  // Keep focus in the palette input whenever it opens.
  useEffect(() => {
    if (!open) return;
    ref.current?.focus();
    requestAnimationFrame(() => ref.current?.focus());
  }, [open, ref]);
  return (
    <div
      className={`fixed inset-0 z-50 flex items-start justify-center pt-[14vh] px-4 bg-black/50 transition-opacity duration-150 ${
        open ? 'opacity-100 backdrop-blur-sm' : 'opacity-0 pointer-events-none invisible'
      }`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      aria-hidden={!open}
    >
      <div
        className={`w-full max-w-xl rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl shadow-black/60 p-4 transition-transform duration-150 ${
          open ? 'translate-y-0 scale-100' : '-translate-y-2 scale-[0.98]'
        }`}
      >
        <OmniForm variant="palette" inputRef={ref} onDone={onClose} />
        <div className="mt-3 pt-2 border-t border-zinc-800 flex justify-between text-[10px] text-zinc-500">
          <span>Enter to open · Esc to close</span>
          <span>⌘/Ctrl + K</span>
        </div>
      </div>
    </div>
  );
};

export const ZenOmnibox: React.FC = () => {
  const layoutMode = useWorkspaceStore((s) => s.layoutMode);
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const close = useCallback(() => setOpen(false), []);

  // Cmd/Ctrl+K toggles; Esc closes. Also opened by other components (e.g. the tab strip's "+").
  // Electron: the palette lives in the overlay view, so this only asks main to open it.
  useEffect(() => {
    if (isOverlayRole) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (isElectron) openOverlay({ kind: 'omnibox' });
        else setOpen((o) => !o);
      } else if (e.key === 'Escape') {
        setOpen(false);
      }
    };
    const onOpen = () => (isElectron ? openOverlay({ kind: 'omnibox' }) : setOpen(true));
    window.addEventListener('keydown', onKey);
    window.addEventListener(OPEN_OMNIBOX_EVENT, onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(OPEN_OMNIBOX_EVENT, onOpen);
    };
  }, []);

  // Native child webviews paint above the DOM: tell PaneContainer to hide them while the palette is open.
  useEffect(() => {
    setOverlay('omnibox', open);
    return () => setOverlay('omnibox', false);
  }, [open]);

  return (
    <>
      {/* Command palette: always mounted, toggled with opacity/transform only. */}
      {!isElectron && <OmniboxPalette open={open} onClose={close} inputRef={inputRef} />}

      {/* Zen floating pill. */}
      {layoutMode === 'zen' && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 w-[min(560px,calc(100vw-2rem))]">
          <div className="rounded-2xl border border-zinc-700 bg-zinc-900/90 backdrop-blur px-4 py-2.5 shadow-xl shadow-black/40 hover:border-zinc-600 transition-colors">
            <OmniForm variant="pill" onDone={() => undefined} />
          </div>
        </div>
      )}
    </>
  );
};
