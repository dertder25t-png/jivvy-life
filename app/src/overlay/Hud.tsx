// The HUD strip (Electron overlay view): find bar, zoom badge, permission prompt and toast,
// stacked in the page area's top-right corner and drawn from main's runtime.hud.
import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { nativeInvoke as invoke } from '../platform';
import { useWorkspaceStore } from '../store/workspaceStore';
import type { HudState, PermPrompt } from '../../shared/ipc';
import type { Rect } from '../../shared/layout';

const WIDTH = 340;
const call = (cmd: string, args?: Record<string, unknown>) => void invoke(cmd, args).catch(() => undefined);
const card = 'rounded-lg bg-zinc-900 border border-zinc-700 shadow-xl shadow-black/50 text-xs text-zinc-200';
const iconBtn = 'p-1 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800';

const FindBar: React.FC<{ find: NonNullable<HudState['find']> }> = ({ find }) => {
  const ref = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(find.text);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
    // Ctrl+F again: main asks for the caret back.
    const on = (e: Event) => {
      if ((e as CustomEvent<{ type: string }>).detail?.type === 'focus-find') {
        ref.current?.focus();
        ref.current?.select();
      }
    };
    window.addEventListener('jivvy:ui', on);
    return () => window.removeEventListener('jivvy:ui', on);
  }, []);
  const step = (forward: boolean) => text && call('find', { text, next: true, forward });
  return (
    <div className={`${card} flex items-center gap-1 pl-2.5 pr-1 py-1`} data-find-bar>
      <input
        ref={ref}
        data-find-input
        value={text}
        spellCheck={false}
        placeholder="Find in page"
        onChange={(e) => {
          setText(e.target.value);
          call('find', { text: e.target.value });
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            step(!e.shiftKey);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            call('find_close');
          }
        }}
        className="flex-1 min-w-0 bg-transparent text-zinc-100 placeholder-zinc-500 focus:outline-none"
      />
      <span data-find-count className="text-zinc-500 tabular-nums shrink-0 px-1">
        {find.text ? `${find.active}/${find.total}` : ''}
      </span>
      <button title="Previous (Shift+Enter)" onClick={() => step(false)} className={iconBtn}>
        <ChevronUp className="w-3.5 h-3.5" />
      </button>
      <button title="Next (Enter)" onClick={() => step(true)} className={iconBtn}>
        <ChevronDown className="w-3.5 h-3.5" />
      </button>
      <button title="Close (Esc)" onClick={() => call('find_close')} className={iconBtn}>
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
};

const PermCard: React.FC<{ perm: PermPrompt }> = ({ perm }) => {
  const [remember, setRemember] = useState(true);
  const answer = (allow: boolean) => call('permission_answer', { id: perm.id, allow, remember });
  return (
    <div className={`${card} p-3 space-y-2`} data-perm-prompt role="alertdialog" aria-label="Site permission">
      <p className="text-zinc-100 break-words">{perm.text}</p>
      <label className="flex items-center gap-2 text-zinc-400 cursor-pointer">
        <input data-perm-remember type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="accent-indigo-500" />
        Remember for this site
      </label>
      <div className="flex justify-end gap-2">
        <button data-perm-block onClick={() => answer(false)} className="px-3 py-1 rounded-lg bg-zinc-800 text-zinc-100 hover:bg-zinc-700">
          Block
        </button>
        <button data-perm-allow onClick={() => answer(true)} className="px-3 py-1 rounded-lg bg-indigo-600 text-white hover:bg-indigo-500">
          Allow
        </button>
      </div>
    </div>
  );
};

export const Hud: React.FC<{ anchor: Rect }> = ({ anchor }) => {
  const hud = useWorkspaceStore((s) => s.runtime.hud);
  const left = Math.max(8, anchor.x + anchor.width - WIDTH - 12);
  return (
    <div data-hud style={{ position: 'fixed', left, top: anchor.y + 8, width: WIDTH }} className="flex flex-col gap-2">
      {hud.perm && <PermCard key={hud.perm.id} perm={hud.perm} />}
      {hud.find && <FindBar find={hud.find} />}
      {hud.zoom && (
        <div className={`${card} self-end flex items-center gap-2 pl-3 pr-1.5 py-1`} data-zoom-badge>
          <span className="tabular-nums text-zinc-100 font-medium">{hud.zoom.percent}%</span>
          <button data-zoom-reset onClick={() => call('zoom_reset')} className="px-2 py-0.5 rounded bg-zinc-800 text-zinc-200 hover:bg-zinc-700">
            Reset
          </button>
        </div>
      )}
      {hud.toast && (
        <div className={`${card} flex items-center gap-2 pl-3 pr-1.5 py-2`} data-toast>
          <span className="flex-1 min-w-0 truncate">{hud.toast.text}</span>
          {hud.toast.downloadId && (
            <button onClick={() => call('download_show', { id: hud.toast!.downloadId })} className="px-2 py-0.5 rounded bg-zinc-800 text-zinc-200 hover:bg-zinc-700 shrink-0">
              Show
            </button>
          )}
          <button title="Dismiss" onClick={() => call('toast_dismiss')} className={iconBtn}>
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
};
