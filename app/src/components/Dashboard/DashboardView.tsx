import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { CornerDownLeft, Search } from 'lucide-react';
import {
  DASH_PREFIXES, PICKABLE, applyLaya, decideDash, forceRoute, needsLaya, routeLabel, unitCalc,
  type DashDecision, type RouteId,
} from '../../lib/router';
import { classify, loadClassifier } from '../../lib/dashboard/classifier';
import { layaClassify, layaHealth } from '../../lib/dashboard/laya';
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
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [npu, setNpu] = useState<'online' | 'offline' | 'loading'>('offline');
  const [recent, setRecent] = usePersisted<RecentItem[]>('recent', []);
  const [links, setLinks] = usePersisted<LinkItem[]>('links', DEFAULT_LINKS);
  const [clfReady, setClfReady] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const toastTimer = useRef<number>(0);

  const showToast = useCallback((m: string) => {
    setToast(m);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3500);
  }, []);

  useEffect(() => {
    loadClassifier().then(() => setClfReady(true));
    taRef.current?.focus();
    return () => window.clearTimeout(toastTimer.current);
  }, []);

  // NPU status dot: poll laya /health while the view is visible.
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      if (document.visibilityState !== 'visible') return;
      const h = await layaHealth();
      if (alive) setNpu(h?.ok ? (h.ready ? 'online' : 'loading') : 'offline');
    };
    poll();
    const id = window.setInterval(poll, 20000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
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
  const decision = useMemo<DashDecision | null>(() => {
    if (pick) return forceRoute(pick, deferred);
    return decideDash(deferred, clfReady ? classify : null);
  }, [deferred, pick, clfReady]);
  const calc = useMemo(() => (deferred.trim() ? unitCalc(deferred) : null), [deferred]);

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
    const fresh = pick ? forceRoute(pick, value) : decideDash(value, clfReady ? classify : null);
    if (!fresh || busy || !fresh.text) return;
    let d = fresh;
    if (!pick && needsLaya(d)) {
      setBusy(true);
      const out = await layaClassify(d.text); // null when laya is down: silent fallback
      setBusy(false);
      if (out) {
        d = applyLaya(d, out.p_ai);
        setNpu('online');
      }
    }
    await run(d);
    setValue('');
    setPick(null);
    requestAnimationFrame(autosize);
  }, [value, clfReady, busy, pick, run]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
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
    }
  };

  const onPickRecent = (i: RecentItem) => {
    if (i.command) copy(i.command).then((ok) => showToast(ok ? 'Claude command copied.' : 'Could not copy.'));
    else if (i.url) openUrl(i.url);
  };

  const dot = npu === 'online' ? 'bg-emerald-400' : npu === 'loading' ? 'bg-amber-400' : 'bg-zinc-600';

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
                  {busy ? 'asking NPU…' : decision.label}
                </span>
                <span className="text-zinc-500 truncate">
                  {pick ? 'picked' : decision.why}
                  {needsLaya(decision) && !pick ? ' · NPU will confirm on Enter' : ''}
                </span>
                {calc && <span className="ml-auto text-emerald-300 font-medium">{calc}</span>}
                <span className={calc ? 'text-zinc-600' : 'ml-auto text-zinc-600'}>
                  Tab: {pick ? routeLabel(pick) : 'auto'}
                </span>
              </>
            ) : (
              <span className="text-zinc-600">Enter sends · Shift+Enter newline · Tab picks a route</span>
            )}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs text-zinc-600">
          {DASH_PREFIXES.map((p) => (
            <button key={p} className="font-mono hover:text-zinc-300"
              onClick={() => { setValue((v) => `${p} ${v.replace(/^![\w-]+\s*/, '')}`); taRef.current?.focus(); }}>
              {p}
            </button>
          ))}
          <span className="inline-flex items-center gap-1.5 ml-2" title={`NPU reader (laya): ${npu}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${dot}`} /> NPU {npu === 'offline' ? 'off' : npu === 'loading' ? 'loading' : 'on'}
          </span>
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
