import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, RotateCw, Search, KeyRound, ShieldCheck, ShieldOff } from 'lucide-react';
import { useWorkspaceStore } from '../store/workspaceStore';
import { decide } from '../lib/router';
import { setOverlay } from '../lib/overlay';
import { useHoverIntent } from '../lib/useHoverIntent';
import { NAV_EVENT } from './TopTabBar';
import { normalizeHost } from '../services/blocking';
import { jivvy, isElectron, isNative, isTauri, floatsToOverlay, nativeInvoke as invoke, openOverlay } from '../platform';
import { LAYOUT } from '../../shared/layout';

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
  // Electron base view with auto-hide: the bar never pushes the page down; it floats over it.
  const revealOverlay = (focus: boolean) => {
    const r = stripRef.current?.getBoundingClientRect();
    if (r) openOverlay({ kind: 'addressbar', anchor: { x: r.left, y: r.top, width: r.width, height: LAYOUT.ADDRESS_BAR_H }, focus });
  };
  const stripTimer = useRef(0);
  const stripEnter = () => {
    if (!floatsToOverlay) return onEnter();
    window.clearTimeout(stripTimer.current);
    stripTimer.current = window.setTimeout(() => revealOverlay(false), LAYOUT.HOVER_OPEN_MS);
  };
  const stripLeave = () => {
    if (!floatsToOverlay) return onLeave();
    window.clearTimeout(stripTimer.current);
  };
  useEffect(() => () => window.clearTimeout(stripTimer.current), []);
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

  const decision = useMemo(() => (focused ? decide(value) : null), [focused, value]);

  // Follow the active tab unless the user is typing.
  useEffect(() => {
    if (!focused) setValue(activeUrl);
  }, [activeUrl, activeTabId, focused]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const d = decide(value);
    if (!d || (d.route !== 'open-url' && !d.text)) return;
    if (d.copy) void navigator.clipboard?.writeText(d.text).catch(() => undefined);
    const title = d.route === 'open-url' ? hostOf(d.url) : `${d.label}: ${d.text.slice(0, 40)}`;
    if (activeTabId && activeType === 'web') navigateTab(activeTabId, d.url, title);
    else openTab({ title, type: 'web', url: d.url });
    inputRef.current?.blur();
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
      {!shown && <div ref={stripRef} className="h-1.5 bg-zinc-900 border-b border-zinc-800 hover:bg-zinc-800" title="Show address bar (Ctrl+L)" />}
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
          onChange={(e) => setValue(e.target.value)}
          onFocus={(e) => {
            setFocused(true);
            e.currentTarget.select();
          }}
          onBlur={() => {
            setFocused(false);
            setValue(activeUrl);
          }}
          onKeyDown={(e) => e.key === 'Escape' && inputRef.current?.blur()}
          spellCheck={false}
          placeholder="Search or enter address"
          className="flex-1 min-w-0 bg-transparent text-xs text-zinc-100 placeholder-zinc-500 focus:outline-none"
        />
        {decision && value.trim() && <span className="text-[10px] text-zinc-500 shrink-0">{decision.label}</span>}
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
    </div>
  );
});
AddressBar.displayName = 'AddressBar';
