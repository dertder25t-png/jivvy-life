// Downloads: the chrome button (shown while any download is listed) and the panel it opens in the overlay.
import React from 'react';
import { Download, FolderOpen, X, File as FileIcon } from 'lucide-react';
import { LAYOUT } from '../../shared/layout';
import { isElectron, nativeInvoke as invoke, openOverlay, viewport } from '../platform';
import { useWorkspaceStore } from '../store/workspaceStore';
import type { DownloadInfo } from '../../shared/ipc';

const call = (cmd: string, args?: Record<string, unknown>) => void invoke(cmd, args).catch(() => undefined);

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

function status(d: DownloadInfo): string {
  if (d.state === 'done') return `${bytes(d.total || d.received)} · ${d.host || 'done'}`;
  if (d.state === 'failed') return 'Failed';
  if (d.state === 'cancelled') return 'Cancelled';
  const of = d.total ? `${bytes(d.received)} of ${bytes(d.total)}` : bytes(d.received);
  return d.speed > 0 ? `${of} · ${bytes(d.speed)}/s` : of;
}

/** Window-coordinate spot for the panel: right-aligned, right under the address bar's row. */
function panelAnchor() {
  const s = useWorkspaceStore.getState();
  const y = (s.layoutMode === 'classic-top' ? LAYOUT.TAB_BAR_H : 0) + LAYOUT.ADDRESS_BAR_H;
  return { x: viewport().width - 8, y, width: 0, height: 0 };
}
export const openDownloads = () => openOverlay({ kind: 'downloads', anchor: panelAnchor() });

export const DownloadsButton: React.FC<{ className?: string }> = ({ className = '' }) => {
  const list = useWorkspaceStore((s) => s.runtime.downloads);
  if (!isElectron || !list.length) return null;
  const active = list.filter((d) => d.state === 'progressing');
  const known = active.filter((d) => d.total > 0);
  const pct = known.length ? Math.round((100 * known.reduce((n, d) => n + d.received, 0)) / known.reduce((n, d) => n + d.total, 0)) : null;
  return (
    <button
      type="button"
      data-downloads-button
      onClick={openDownloads}
      title={active.length ? `${active.length} download${active.length > 1 ? 's' : ''} in progress${pct !== null ? ` (${pct}%)` : ''}` : 'Downloads (Ctrl+J)'}
      className={`relative p-1.5 rounded hover:bg-zinc-800 ${active.length ? 'text-indigo-300' : 'text-zinc-400 hover:text-zinc-100'} ${className}`}
    >
      <Download className="w-3.5 h-3.5" />
      {active.length > 0 && (
        <span className="absolute left-1 right-1 bottom-0.5 h-0.5 rounded bg-zinc-700 overflow-hidden">
          <span className={`block h-full bg-indigo-400 ${pct === null ? 'w-1/3 animate-pulse' : ''}`} style={pct === null ? undefined : { width: `${pct}%` }} />
        </span>
      )}
    </button>
  );
};

const Row: React.FC<{ d: DownloadInfo }> = ({ d }) => {
  const pct = d.total ? Math.min(100, Math.round((100 * d.received) / d.total)) : null;
  return (
    <li data-download-row={d.id} className="px-3 py-2 space-y-1">
      <div className="flex items-center gap-2">
        <FileIcon className="w-4 h-4 text-zinc-500 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="truncate text-xs text-zinc-100" title={d.name}>
            {d.name}
          </div>
          <div className={`truncate text-[11px] ${d.state === 'failed' ? 'text-red-300' : 'text-zinc-500'}`}>{status(d)}</div>
        </div>
        {d.state === 'progressing' && (
          <button title="Cancel" data-action="download-cancel" onClick={() => call('download_cancel', { id: d.id })} className="p-1 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800">
            <X className="w-3.5 h-3.5" />
          </button>
        )}
        {d.state === 'done' && (
          <>
            <button data-action="download-open" onClick={() => call('download_open', { id: d.id })} className="px-2 py-0.5 text-[11px] rounded bg-zinc-800 text-zinc-200 hover:bg-zinc-700">
              Open
            </button>
            <button title="Show in folder" data-action="download-show" onClick={() => call('download_show', { id: d.id })} className="p-1 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800">
              <FolderOpen className="w-3.5 h-3.5" />
            </button>
          </>
        )}
      </div>
      {d.state === 'progressing' && (
        <div role="progressbar" aria-valuenow={pct ?? undefined} aria-valuemin={0} aria-valuemax={100} className="h-1 rounded bg-zinc-800 overflow-hidden">
          <div className={`h-full bg-indigo-500 ${pct === null ? 'w-1/3 animate-pulse' : ''}`} style={pct === null ? undefined : { width: `${pct}%` }} />
        </div>
      )}
    </li>
  );
};

export const DownloadsPanel: React.FC<{ anchor: { x: number; y: number } }> = ({ anchor }) => {
  const list = useWorkspaceStore((s) => s.runtime.downloads);
  const W = 380;
  const finished = list.some((d) => d.state !== 'progressing');
  return (
    <div
      data-downloads-panel
      style={{ position: 'fixed', left: Math.max(8, anchor.x - W), top: anchor.y + 4, width: W }}
      className="bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl shadow-black/50 overflow-hidden"
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800">
        <span className="text-xs font-semibold text-zinc-200">Downloads</span>
        <button
          data-action="downloads-clear"
          disabled={!finished}
          onClick={() => call('downloads_clear')}
          className="text-[11px] text-zinc-400 hover:text-zinc-100 disabled:opacity-40 disabled:hover:text-zinc-400"
        >
          Clear
        </button>
      </div>
      {list.length === 0 ? (
        <p className="px-3 py-4 text-xs text-zinc-500">No downloads.</p>
      ) : (
        <ul className="max-h-[60vh] overflow-y-auto divide-y divide-zinc-800">
          {list.map((d) => (
            <Row key={d.id} d={d} />
          ))}
        </ul>
      )}
    </div>
  );
};
