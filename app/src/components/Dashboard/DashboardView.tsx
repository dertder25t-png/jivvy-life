import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { CornerDownLeft, Search } from 'lucide-react';
import { DASH_PREFIXES, PICKABLE, forceRoute, routeLabel, type DashDecision, type RouteId } from '../../lib/router';
import { recordTyped, route, suggest, toDash, usePredictions } from '../../lib/predictions';
import { SuggestRows } from '../AddressBar';
import { usePersisted } from '../../lib/dashboard/store';
import {
  BriefCard, CLS_STYLE, DEFAULT_LINKS, FocusCard, LinksCard, NotesCard, RecentCard, TodayCard, openUrl,
  type LinkItem, type RecentItem,
} from './Cards';

type Pick = RouteId | 'code' | null;

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export const DashboardView: React.FC = () => {
  const [value, setValue] = useState('');
  const [pick, setPick] = useState<Pick>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [recent, setRecent] = usePersisted<RecentItem[]>('recent', []);
  const [links, setLinks] = usePersisted<LinkItem[]>('links', DEFAULT_LINKS);
  const [sel, setSel] = useState(-1);
  const snap = usePredictions();
  const taRef = useRef<HTMLTextAreaElement>(null);
  const toastTimer = useRef<number>(0);

  const showToast = useCallback((m: string) => {
    setToast(m);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3500);
  }, []);

  useEffect(() => {
    taRef.current?.focus();
    return () => window.clearTimeout(toastTimer.current);
  }, []);

  // Alt+1..9 opens the numbered link.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      const n = /^Digit([1-9])$/.exec(e.code)?.[1];
      if (!n) return;
      const l = links[Number(n) - 1];
      if (l) {
        e.preventDefault();
        openUrl(l.url);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [links]);

  const deferred = useDeferredValue(value);
  // Routing and suggestions come from the ported Lifeboard decide()/complete() and the nightly snapshot.
  const routed = useMemo(() => route(deferred, snap), [deferred, snap]);
  const decision = useMemo<DashDecision | null>(() => (pick ? forceRoute(pick, deferred) : toDash(routed)), [deferred, pick, routed]);
  const calc = routed?.calc ?? null;
  const rows = useMemo(() => {
    if (!deferred.trim() || /\n/.test(deferred) || /^\s*!/.test(deferred)) return [];
    return suggest(deferred, snap).suggestions.map((x) => ({ url: x.url, title: x.title, host: x.host }));
  }, [deferred, snap]);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const autosize = () => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  };

  const run = useCallback(
    async (d: DashDecision) => {
      if (d.cls === 'code') {
        const ok = await copy(d.command || '');
        showToast(ok ? 'Claude command copied. Paste it in your terminal.' : 'Could not copy. Command: ' + d.command);
      } else {
        if (d.copy) {
          const ok = await copy(d.text);
          if (ok && d.hint) showToast(d.hint);
        } else if (d.hint) showToast(d.hint);
        openUrl(d.url);
      }
      const item: RecentItem = {
        id: `${Date.now()}`, text: d.text || value, label: d.label, cls: d.cls, t: Date.now(),
        url: d.cls === 'code' ? undefined : d.url, command: d.command,
      };
      setRecent((r) => [item, ...r.filter((x) => x.text !== item.text || x.label !== item.label)].slice(0, 20));
    },
    [setRecent, showToast, value]
  );

  const submit = useCallback(async () => {
    // Decide from the live value: `decision` uses a deferred copy that can lag a fast Enter.
    const shown = rowsRef.current[sel];
    if (shown) {
      recordTyped({ text: value, url: shown.url, shownUrl: shown.url, accepted: true });
      openUrl(shown.url);
    } else {
      const d = pick ? forceRoute(pick, value) : toDash(route(value, snap));
      if (!d || !d.text) return;
      if (!pick) recordTyped({ text: value, url: d.cls === 'url' ? d.url : '', shownUrl: rowsRef.current[0]?.url, accepted: false });
      await run(d);
    }
    setValue('');
    setPick(null);
    setSel(-1);
    requestAnimationFrame(autosize);
  }, [value, pick, run, sel, snap]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && rowsRef.current.length && !/\n/.test(value)) {
      e.preventDefault();
      const n = rowsRef.current.length;
      setSel((i) => (e.key === 'ArrowDown' ? Math.min(n - 1, i + 1) : Math.max(-1, i - 1)));
    } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    } else if (e.key === 'Tab' && value.trim()) {
      e.preventDefault();
      const order: Pick[] = [null, ...PICKABLE];
      const i = order.indexOf(pick);
      setPick(order[(i + (e.shiftKey ? -1 : 1) + order.length) % order.length]);
    } else if (e.key === 'Escape') {
      setValue('');
      setPick(null);
      setSel(-1);
    }
  };

  const onPickRecent = (i: RecentItem) => {
    if (i.command) copy(i.command).then((ok) => showToast(ok ? 'Claude command copied.' : 'Could not copy.'));
    else if (i.url) openUrl(i.url);
  };

  return (
    <div className="h-full w-full overflow-y-auto bg-zinc-950 text-zinc-100">
      <div className="mx-auto max-w-4xl px-6 pt-[14vh] pb-12">
        <div className="relative rounded-2xl border border-zinc-800 bg-zinc-900 shadow-lg focus-within:border-zinc-600 transition-colors">
          <div className="flex items-start gap-3 px-5 pt-4">
            <Search className="w-5 h-5 mt-1 text-zinc-500 shrink-0" />
            <textarea
              ref={taRef}
              rows={1}
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setSel(-1);
                if (!e.target.value) setPick(null);
                autosize();
              }}
              onKeyDown={onKeyDown}
              placeholder="Search, ask, or start a coding job"
              spellCheck={false}
              className="flex-1 resize-none bg-transparent text-lg leading-7 text-zinc-100 placeholder-zinc-500 focus:outline-none"
            />
            <button onClick={submit} className="mt-1 text-zinc-600 hover:text-zinc-300" title="Send (Enter)" aria-label="Send">
              <CornerDownLeft className="w-4 h-4" />
            </button>
          </div>
          <div className="flex items-center gap-2 px-5 pb-3 pt-2 min-h-[2.25rem] text-xs">
            {decision && decision.text ? (
              <>
                <span className={`px-2 py-0.5 rounded-full border ${CLS_STYLE[decision.cls] || CLS_STYLE.search}`}>
                  {decision.cls === 'url' ? '→ ' : ''}{decision.label}
                </span>
                <span className="text-zinc-500 truncate">{pick ? 'picked' : decision.why}</span>
                {calc && <span className="ml-auto text-emerald-300 font-medium">{calc}</span>}
                <span className={calc ? 'text-zinc-600' : 'ml-auto text-zinc-600'}>
                  Tab: {pick ? routeLabel(pick) : 'auto'}
                </span>
              </>
            ) : (
              <span className="text-zinc-600">Enter sends · Shift+Enter newline · Tab picks a route</span>
            )}
          </div>
          {rows.length > 0 && (
            <div className="px-3 pb-3" data-dash-suggest>
              <SuggestRows items={rows} selected={sel} onPick={(i) => { setSel(i); const r = rows[i]; recordTyped({ text: value, url: r.url, shownUrl: r.url, accepted: true }); openUrl(r.url); setValue(''); setSel(-1); }} className="!shadow-none !border-zinc-800 !bg-zinc-950" />
            </div>
          )}
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs text-zinc-600">
          {DASH_PREFIXES.map((p) => (
            <button key={p} className="font-mono hover:text-zinc-300"
              onClick={() => { setValue((v) => `${p} ${v.replace(/^![\w-]+\s*/, '')}`); taRef.current?.focus(); }}>
              {p}
            </button>
          ))}
        </div>

        <div className="mt-10 grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
          <TodayCard />
          <RecentCard items={recent} onPick={onPickRecent} onClear={() => setRecent([])} />
          <LinksCard links={links} setLinks={setLinks} />
          <BriefCard />
          <NotesCard />
          <FocusCard toast={showToast} />
        </div>
      </div>

      {toast && (
        <div role="status" className="fixed bottom-6 left-1/2 -translate-x-1/2 max-w-[80vw] rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm text-zinc-100 shadow-xl">
          {toast}
        </div>
      )}
    </div>
  );
};

export default DashboardView;
