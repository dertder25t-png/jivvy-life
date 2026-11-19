import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, RotateCw, Search, KeyRound, ShieldCheck, ShieldOff } from 'lucide-react';
import { useWorkspaceStore } from '../store/workspaceStore';
import { destination, recordTyped, route, suggest, usePredictions } from '../lib/predictions';
import type { Completion } from '../../shared/lifeboard';
import type { Visit } from '../../shared/history-types';
import { setOverlay } from '../lib/overlay';
import { useHoverIntent } from '../lib/useHoverIntent';
import { NAV_EVENT } from './TopTabBar';
import { normalizeHost } from '../services/blocking';
import { jivvy, isElectron, isNative, isTauri, floatsToOverlay, nativeInvoke as invoke, openOverlay } from '../platform';
import { LAYOUT, chromeInsets } from '../../shared/layout';
import type { SuggestItem } from '../../shared/ipc';

const MAX_ROWS = 6;
/** Show an address without its scheme and trailing slash, like a browser does in its list. */
const shortUrl = (u: string) => u.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');

/** The suggestion rows. Mouse down (not click) picks, so the address input never loses focus first. */
export const SuggestRows: React.FC<{ items: SuggestItem[]; selected: number; onPick: (i: number) => void; className?: string }> = ({ items, selected, onPick, className = '' }) => (
  <ul role="listbox" className={`bg-zinc-900 border border-zinc-700 rounded-md shadow-xl shadow-black/50 py-1 overflow-hidden ${className}`}>
    {items.map((it, i) => (
      <li
        key={it.url}
        role="option"
        aria-selected={i === selected}
        data-suggest-row
        onMouseDown={(e) => {
          e.preventDefault();
          onPick(i);
        }}
        className={`flex items-baseline gap-2 px-3 py-1.5 text-xs cursor-pointer ${i === selected ? 'bg-indigo-600/30 text-zinc-50' : 'text-zinc-300 hover:bg-zinc-800'}`}
      >
        <span className="truncate font-medium shrink-0 max-w-[45%]">{it.host}</span>
        <span className="truncate text-zinc-500">{it.title || shortUrl(it.url)}</span>
      </li>
    ))}
  </ul>
);

function hostOf(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return 'web';
  }
}

const NavBtn: React.FC<{ title: string; onClick: () => void; children: React.ReactNode }> = ({ title, onClick, children }) => (
  <button onClick={onClick} title={title} className="p-1.5 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800">
    {children}
  </button>
);

/**
 * The one address bar: shows the active tab's URL; Enter navigates it (or opens a new tab).
 * `floating`: the Electron overlay copy, revealed over the page from the auto-hide strip.
 */
export const AddressBar: React.FC<{ floating?: boolean; autoFocus?: boolean }> = React.memo(({ floating = false, autoFocus = false }) => {
  const activeUrl = useWorkspaceStore((s) => {
    const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId);
    return ws?.tabs.find((t) => t.id === ws.primaryTabId)?.url ?? '';
  });
  const activeTabId = useWorkspaceStore((s) => {
    const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId);
    return ws?.primaryTabId ?? null;
  });
  const activeType = useWorkspaceStore((s) => {
    const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId);
    return ws?.tabs.find((t) => t.id === ws.primaryTabId)?.type ?? null;
  });
  const openTab = useWorkspaceStore((s) => s.openTab);
  const navigateTab = useWorkspaceStore((s) => s.navigateTab);
  const autoHide = useWorkspaceStore((s) => s.autoHideAddressBar);
  const activeHost = activeUrl ? hostOf(activeUrl) : '';
  const blockingEnabled = useWorkspaceStore((s) => s.blockingEnabled);
  const disabledSites = useWorkspaceStore((s) => s.blockingDisabledSites);
  const setDisabledSites = useWorkspaceStore((s) => s.setBlockingDisabledSites);
  // The listed site matching this host (the host itself or a parent domain), if blocking is off for it.
  const siteHost = normalizeHost(activeHost);
  const matchedSite = siteHost
    ? disabledSites.find((d) => siteHost === d || siteHost.endsWith(`.${d}`))
    : undefined;
  const toggleSiteBlocking = () => {
    if (!siteHost) return;
    setDisabledSites(matchedSite ? disabledSites.filter((d) => d !== matchedSite) : [...disabledSites, siteHost]);
  };
  const activeUrlRef = useRef(activeUrl);
  activeUrlRef.current = activeUrl;
  const [logins, setLogins] = useState<string[]>([]);
  const [pickOpen, setPickOpen] = useState(false);
  const { active: hovered, onEnter, onLeave, force: setHovered } = useHoverIntent(150, 400);

  const [value, setValue] = useState(activeUrl);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const shown = floating || !autoHide || ((hovered || focused) && !floatsToOverlay);
  const stripRef = useRef<HTMLDivElement>(null);
  // Electron base view with auto-hide: the bar reserves no space and never pushes the page down;
  // main floats it over the page (overlay view) when the top-edge hover strip is entered, or on
  // Ctrl+L, anchored where the bar would sit.
  const revealOverlay = (focus: boolean) => {
    const s = useWorkspaceStore.getState();
    const left = chromeInsets({ layoutMode: s.layoutMode, showTopBar: s.showTopBar, autoHideAddressBar: s.autoHideAddressBar, zenBarPosition: s.zenBarPosition }).left;
    const y = s.layoutMode === 'classic-top' ? LAYOUT.TAB_BAR_H : 0;
    openOverlay({ kind: 'addressbar', anchor: { x: left, y, width: Math.max(1, window.innerWidth - left), height: LAYOUT.ADDRESS_BAR_H }, focus });
  };
  const stripEnter = () => {
    if (!floatsToOverlay) onEnter();
  };
  const stripLeave = () => {
    if (!floatsToOverlay) onLeave();
  };
  useEffect(() => {
    if (autoFocus) requestAnimationFrame(() => inputRef.current?.focus());
  }, [autoFocus]);

  // Ctrl/Cmd+L reveals and focuses the address bar, like a browser.
  useEffect(() => {
    const focusAddress = () => {
      if (floatsToOverlay && autoHide) return revealOverlay(true);
      setHovered(true);
      requestAnimationFrame(() => inputRef.current?.focus());
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        focusAddress();
      }
    };
    // Electron: Ctrl+L pressed inside a web page arrives from main as a UI event.
    const onUi = (e: Event) => (e as CustomEvent<{ type: string }>).detail?.type === 'focus-address' && focusAddress();
    if (!floating) window.addEventListener('keydown', onKey);
    if (!floating && isElectron) window.addEventListener('jivvy:ui', onUi);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('jivvy:ui', onUi);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setHovered, floating, autoHide]);

  // Offer a key button when saved logins exist for the active web tab's origin (Tauri only).
  useEffect(() => {
    setPickOpen(false);
    setLogins([]);
    if (!isTauri || activeType !== 'web' || !activeHost) return;
    let live = true;
    invoke<string[]>('logins_for', { origin: activeUrlRef.current })
      .then((l) => live && setLogins(l))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [activeHost, activeType, activeTabId]);

  // Native pane webviews paint above HTML: hide them while the picker is open.
  useEffect(() => {
    setOverlay('loginpicker', pickOpen);
    return () => setOverlay('loginpicker', false);
  }, [pickOpen]);

  const fill = (username: string) => {
    setPickOpen(false);
    if (activeTabId) void invoke('fill_login', { label: `pane_${activeTabId}`, username }).catch(() => {});
  };

  const snap = usePredictions();
  const decision = focused && value.trim() ? route(value, snap) : null;

  // ---- Inline autocomplete + suggestion dropdown -------------------------------------------
  // `fill` is the inline completion currently appended (selected) in the box: typing replaces it,
  // Backspace removes it, Enter opens fill.url. `comp` feeds the dropdown (up to 6 rows).
  const [comp, setComp] = useState<Completion | null>(null);
  const [sel, setSel] = useState(-1);
  const [dismissed, setDismissed] = useState(false);
  const fillRef = useRef<{ typed: string; inline: string; url: string } | null>(null);
  const typedRef = useRef(''); // what the user typed, before arrow keys swapped in a suggestion
  const pendingSel = useRef<[number, number] | null>(null);
  const recentRef = useRef<Visit[] | undefined>(undefined);
  const blurTimer = useRef(0);
  const items: SuggestItem[] = comp && !dismissed && focused ? comp.suggestions.slice(0, MAX_ROWS).map((x) => ({ url: x.url, title: x.title, host: x.host })) : [];
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const selRef = useRef(sel);
  selRef.current = sel;
  const suggestOpen = items.length > 0;

  // Put the caret selection over the inline part once React has rendered the new value.
  useLayoutEffect(() => {
    const r = pendingSel.current;
    pendingSel.current = null;
    if (r && inputRef.current && document.activeElement === inputRef.current) inputRef.current.setSelectionRange(r[0], r[1]);
  });

  const resetSuggest = () => {
    fillRef.current = null;
    typedRef.current = '';
    setComp(null);
    setSel(-1);
    setDismissed(false);
  };

  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    const ne = e.nativeEvent as InputEvent;
    typedRef.current = v;
    setSel(-1);
    setDismissed(false);
    if (!v.trim()) {
      fillRef.current = null;
      setComp(null);
      setValue(v);
      return;
    }
    const c = suggest(v, snap, recentRef.current);
    setComp(c);
    // Deleting (Backspace on the selected inline part, Delete, cut) or composing never re-fills.
    if (c.inline && c.url && !ne.isComposing && !(ne.inputType || '').startsWith('delete') && e.target.selectionStart === v.length) {
      fillRef.current = { typed: v, inline: c.inline, url: c.url };
      pendingSel.current = [v.length, v.length + c.inline.length];
      setValue(v + c.inline);
    } else {
      fillRef.current = null;
      setValue(v);
    }
  };

  // Overlay-hosted dropdown for the base view's bar (Electron): the page views paint above this
  // view, so the list goes to the overlay view, which floats over them. It never takes focus.
  const overlayList = isElectron && !floating;
  const listOpenRef = useRef(false);
  useEffect(() => {
    if (!overlayList) return;
    if (suggestOpen && inputRef.current) {
      const r = inputRef.current.getBoundingClientRect();
      openOverlay({ kind: 'suggest', anchor: { x: r.left, y: r.bottom + 4, width: r.width, height: 0 }, items, selected: sel });
      listOpenRef.current = true;
    } else if (listOpenRef.current) {
      listOpenRef.current = false;
      jivvy?.overlayClose();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlayList, suggestOpen, comp, sel, dismissed]);
  useEffect(
    () => () => {
      window.clearTimeout(blurTimer.current);
      if (listOpenRef.current) jivvy?.overlayClose();
    },
    []
  );
  // Tauri: native pane webviews paint above HTML, so hide them while the list is open.
  useEffect(() => {
    if (!isTauri) return;
    setOverlay('suggest', suggestOpen);
    return () => setOverlay('suggest', false);
  }, [suggestOpen]);

  // Follow the active tab unless the user is typing.
  useEffect(() => {
    if (!focused) setValue(activeUrl);
  }, [activeUrl, activeTabId, focused]);

  const go = (url: string, title: string) => {
    if (activeTabId && activeType === 'web') navigateTab(activeTabId, url, title);
    else openTab({ title, type: 'web', url });
    resetSuggest();
    window.clearTimeout(blurTimer.current);
    inputRef.current?.blur();
  };

  const openSuggestion = useCallback(
    (i: number) => {
      const it = itemsRef.current[i];
      if (!it) return;
      recordTyped({ text: typedRef.current || it.host, url: it.url, shownUrl: it.url, accepted: true });
      go(it.url, it.title || hostOf(it.url));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeTabId, activeType]
  );
  const openSuggestionRef = useRef(openSuggestion);
  openSuggestionRef.current = openSuggestion;
  useEffect(() => {
    if (!overlayList) return;
    const onUi = (e: Event) => {
      const d = (e as CustomEvent<{ type: string; index?: number }>).detail;
      if (d?.type === 'suggest-pick' && typeof d.index === 'number') openSuggestionRef.current(d.index);
    };
    window.addEventListener('jivvy:ui', onUi);
    return () => window.removeEventListener('jivvy:ui', onUi);
  }, [overlayList]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (selRef.current >= 0 && itemsRef.current[selRef.current]) return openSuggestion(selRef.current);
    const fill = fillRef.current;
    if (fill && value === fill.typed + fill.inline) {
      recordTyped({ text: fill.typed, url: fill.url, shownUrl: fill.url, accepted: true });
      return go(fill.url, hostOf(fill.url));
    }
    const d = route(value, snap);
    if (!d || (d.route !== 'open-url' && !d.text)) return;
    if (d.copy) void navigator.clipboard?.writeText(d.text).catch(() => undefined);
    const dest = destination(d);
    recordTyped({ text: typedRef.current || value, url: d.route === 'open-url' ? dest.url : '', shownUrl: comp?.url, accepted: false });
    go(dest.url, d.route === 'open-url' ? hostOf(dest.url) : `${dest.label}: ${d.text.slice(0, 40)}`);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      if (suggestOpen) {
        e.preventDefault();
        e.stopPropagation();
        setDismissed(true);
        setSel(-1);
      } else inputRef.current?.blur();
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && suggestOpen && !e.nativeEvent.isComposing) {
      e.preventDefault();
      const n = itemsRef.current.length;
      const next = e.key === 'ArrowDown' ? Math.min(n - 1, sel + 1) : sel - 1;
      setSel(next);
      fillRef.current = null;
      // Show where Enter would go; going back above the first row restores what was typed.
      setValue(next >= 0 ? shortUrl(itemsRef.current[next].url) : typedRef.current);
    }
  };

  const nav = (action: 'back' | 'forward' | 'reload') => {
    if (jivvy) {
      if (activeTabId) jivvy.tabNav(activeTabId, action);
      return;
    }
    window.dispatchEvent(new CustomEvent(NAV_EVENT, { detail: { action } }));
    if (action !== 'reload' || isTauri) return;
    const frame = document.querySelector<HTMLIFrameElement>('iframe');
    if (frame) frame.src = frame.src;
  };

  return (
    <div onMouseEnter={stripEnter} onMouseLeave={stripLeave} className="shrink-0">
      {/* Hidden state: a thin hover strip along the top edge. Height switches instantly (no
          animation) so a native pane webview is repositioned once, not every frame. */}
      {!shown && !floatsToOverlay && <div ref={stripRef} className="h-1.5 bg-zinc-900 border-b border-zinc-800 hover:bg-zinc-800" title="Show address bar (Ctrl+L)" />}
    <form onSubmit={submit} className={`h-10 flex items-center gap-1 px-2 bg-zinc-900 border-b border-zinc-800 ${shown ? '' : 'hidden'}`}>
      <NavBtn title="Back" onClick={() => nav('back')}>
        <ArrowLeft className="w-4 h-4" />
      </NavBtn>
      <NavBtn title="Forward" onClick={() => nav('forward')}>
        <ArrowRight className="w-4 h-4" />
      </NavBtn>
      <NavBtn title="Reload" onClick={() => nav('reload')}>
        <RotateCw className="w-3.5 h-3.5" />
      </NavBtn>
      <div className="flex-1 min-w-0 flex items-center gap-2 bg-zinc-950 border border-zinc-800 focus-within:border-indigo-500 rounded-md px-2.5 h-7">
        <Search className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
        <input
          ref={inputRef}
          value={value}
          onChange={onChange}
          onFocus={(e) => {
            window.clearTimeout(blurTimer.current);
            setFocused(true);
            e.currentTarget.select();
            if (jivvy) void jivvy.historyRecent(100).then((r) => (recentRef.current = r), () => undefined);
          }}
          onBlur={() => {
            // Delayed: a click on the overlay-hosted list moves focus to the overlay view first.
            window.clearTimeout(blurTimer.current);
            blurTimer.current = window.setTimeout(
              () => {
                setFocused(false);
                setValue(activeUrl);
                resetSuggest();
              },
              overlayList ? 250 : 0
            );
          }}
          onKeyDown={onKeyDown}
          spellCheck={false}
          placeholder="Search or enter address"
          className="flex-1 min-w-0 bg-transparent text-xs text-zinc-100 placeholder-zinc-500 focus:outline-none"
        />
        {decision && value.trim() && <span className="text-[10px] text-zinc-500 shrink-0">{decision.route === 'open-url' ? '→ ' : ''}{decision.label}</span>}
      </div>
      {isNative && activeType === 'web' && siteHost && blockingEnabled && (
        <button
          type="button"
          onClick={toggleSiteBlocking}
          title={matchedSite ? `Blocking is off for ${matchedSite}. Click to turn it on (reload to apply).` : `Blocking ads & trackers on ${siteHost}. Click to turn off for this site (reload to apply).`}
          className={`p-1.5 rounded hover:bg-zinc-800 ${matchedSite ? 'text-zinc-500' : 'text-emerald-400'}`}
        >
          {matchedSite ? <ShieldOff className="w-3.5 h-3.5" /> : <ShieldCheck className="w-3.5 h-3.5" />}
        </button>
      )}
      {logins.length > 0 && (
        <div className="relative">
          <NavBtn title="Fill saved login" onClick={() => (logins.length === 1 ? fill(logins[0]) : setPickOpen((o) => !o))}>
            <KeyRound className="w-3.5 h-3.5" />
          </NavBtn>
          {pickOpen && (
            <div className="absolute right-0 top-full mt-1 z-50 min-w-40 bg-zinc-900 border border-zinc-700 rounded-md shadow-lg py-1">
              {logins.map((u) => (
                <button key={u} type="button" onClick={() => fill(u)} className="block w-full text-left px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-800">
                  {u}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </form>
    {suggestOpen && !overlayList && (
      // Floating bar (overlay view): in flow, so the overlay measures and grows to include it.
      // Other shells: a plain absolute dropdown under the bar.
      <div className={floating ? 'px-2 pt-1' : 'relative'}>
        <SuggestRows items={items} selected={sel} onPick={openSuggestion} className={floating ? '' : 'absolute left-12 right-2 top-1 z-50'} />
      </div>
    )}
    </div>
  );
});
AddressBar.displayName = 'AddressBar';
