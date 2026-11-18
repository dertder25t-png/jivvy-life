import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Play, Pause, RotateCcw, X, Plus, Pencil, Check } from 'lucide-react';
import { usePersisted } from '../../lib/dashboard/store';

export interface RecentItem {
  id: string;
  text: string;
  label: string;
  cls: string;
  t: number;
  url?: string;
  command?: string;
}
export interface LinkItem {
  name: string;
  url: string;
}

export const DEFAULT_LINKS: LinkItem[] = [
  { name: 'Claude', url: 'https://claude.ai' },
  { name: 'ChatGPT', url: 'https://chatgpt.com' },
  { name: 'Gmail', url: 'https://mail.google.com' },
  { name: 'Calendar', url: 'https://calendar.google.com' },
  { name: 'GitHub', url: 'https://github.com' },
];

export const CLS_STYLE: Record<string, string> = {
  search: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  ask: 'bg-violet-500/15 text-violet-300 border-violet-500/30',
  deep: 'bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/30',
  url: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  code: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
};

const Card: React.FC<{ title: string; right?: React.ReactNode; children: React.ReactNode }> = ({ title, right, children }) => (
  <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 min-w-0">
    <header className="flex items-center justify-between mb-3">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">{title}</h3>
      {right}
    </header>
    {children}
  </section>
);

const muted = 'text-sm text-zinc-500';
const iconBtn = 'p-1 rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800';

export const openUrl = (url: string) => window.dispatchEvent(new CustomEvent('lifeapp:open-url', { detail: { url } }));

/* ---------- Today ---------- */
export const TodayCard = memo(function TodayCard() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const tick = () => document.visibilityState === 'visible' && setNow(new Date());
    const id = window.setInterval(tick, 15000);
    return () => window.clearInterval(id);
  }, []);
  const h = now.getHours();
  const greet = h < 5 ? 'Late night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  return (
    <Card title="Today">
      <div className="text-4xl font-light text-zinc-100 tabular-nums">
        {now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
      </div>
      <div className="text-sm text-zinc-400 mt-1">
        {now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}
      </div>
      <div className="text-xs text-zinc-600 mt-2">{greet}</div>
    </Card>
  );
});

/* ---------- Recent ---------- */
export const RecentCard = memo(function RecentCard({
  items,
  onPick,
  onClear,
}: {
  items: RecentItem[];
  onPick: (i: RecentItem) => void;
  onClear: () => void;
}) {
  return (
    <Card
      title="Recent"
      right={items.length ? <button className="text-xs text-zinc-600 hover:text-zinc-300" onClick={onClear}>Clear</button> : null}
    >
      {items.length === 0 ? (
        <p className={muted}>Nothing yet. Ask something above.</p>
      ) : (
        <ul className="space-y-1">
          {items.slice(0, 6).map((i) => (
            <li key={i.id}>
              <button
                onClick={() => onPick(i)}
                className="w-full flex items-center gap-2 text-left rounded px-1.5 py-1 hover:bg-zinc-800"
                title={i.text}
              >
                <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded-full border ${CLS_STYLE[i.cls] || CLS_STYLE.search}`}>{i.label}</span>
                <span className="truncate text-sm text-zinc-300">{i.text}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
});

/* ---------- Links (Alt+1..9 handled by the view) ---------- */
export const LinksCard = memo(function LinksCard({ links, setLinks }: { links: LinkItem[]; setLinks: (l: LinkItem[]) => void }) {
  const [edit, setEdit] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const add = () => {
    const u = url.trim();
    if (!u) return;
    const full = /^https?:\/\//i.test(u) ? u : `https://${u}`;
    setLinks([...links, { name: name.trim() || full.replace(/^https?:\/\/(www\.)?/, '').split('/')[0], url: full }].slice(0, 24));
    setName('');
    setUrl('');
  };
  const field = 'min-w-0 flex-1 rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none';
  return (
    <Card
      title="Links"
      right={
        <button className={iconBtn} onClick={() => setEdit((e) => !e)} title={edit ? 'Done' : 'Edit links'}>
          {edit ? <Check className="w-3.5 h-3.5" /> : <Pencil className="w-3.5 h-3.5" />}
        </button>
      }
    >
      <div className="flex flex-wrap gap-1.5">
        {links.map((l, i) => (
          <span key={l.url + i} className="inline-flex items-center rounded-md border border-zinc-800 bg-zinc-800/60 hover:bg-zinc-800 text-sm text-zinc-300">
            <button className="px-2 py-1 inline-flex items-center gap-1.5" onClick={() => openUrl(l.url)} title={l.url}>
              {i < 9 && <kbd className="text-[9px] text-zinc-600">Alt+{i + 1}</kbd>}
              {l.name}
            </button>
            {edit && (
              <button className="pr-1.5 text-zinc-500 hover:text-red-400" onClick={() => setLinks(links.filter((_, j) => j !== i))} title="Remove">
                <X className="w-3 h-3" />
              </button>
            )}
          </span>
        ))}
      </div>
      {edit && (
        <div className="flex gap-1.5 mt-3">
          <input className={field} placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <input className={field} placeholder="URL" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
          <button className={iconBtn} onClick={add} title="Add"><Plus className="w-4 h-4" /></button>
        </div>
      )}
    </Card>
  );
});

/* ---------- Daily brief (Downloads sorter) ---------- */
interface Brief {
  t?: number;
  dir?: string;
  downloads?: {
    moved?: number;
    left?: number;
    buckets?: Record<string, unknown[]>;
    waiting?: Record<string, { count?: number; size?: number }>;
  };
}
const SAFE = '2 Keep safe', DEL = '1 Maybe delete', FILE = '3 File away';
const human = (n: number) => {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) (n /= 1024), i++;
  return `${i ? n.toFixed(1) : n.toFixed(0)} ${u[i]}`;
};
const ago = (t: number) => {
  const h = (Date.now() - t) / 3.6e6;
  return h < 1 ? 'just now' : h < 24 ? `${Math.round(h)} h ago` : `${Math.round(h / 24)} d ago`;
};

export const BriefCard = memo(function BriefCard() {
  const [b, setB] = useState<Brief | null | undefined>(undefined);
  useEffect(() => {
    invoke<Brief | null>('read_brief').then(setB, () => setB(null));
  }, []);
  const reveal = (p: string) => invoke('open_path', { path: p }).catch(() => {});
  if (b === undefined) return <Card title="Daily brief"><p className={muted}>Loading…</p></Card>;
  if (!b) return <Card title="Daily brief"><p className={muted}>No brief yet. The Downloads sorter writes one each night.</p></Card>;
  const d = b.downloads || {};
  const bk = d.buckets || {}, w = d.waiting || {};
  const dir = b.dir || '';
  const safe = w[SAFE]?.count ?? (bk[SAFE] || []).length;
  const del = w[DEL];
  const file = w[FILE]?.count ?? (bk[FILE] || []).length;
  const rows: Array<[string, string, string?]> = [];
  if (safe) rows.push([`${safe} sensitive file${safe > 1 ? 's' : ''} to put somewhere safe`, 'text-amber-300', `${dir}/${SAFE}`]);
  if (del?.count) rows.push([`${del.count} to look over and maybe delete (${human(del.size || 0)})`, 'text-zinc-300', `${dir}/${DEL}`]);
  if (file) rows.push([`${file} to file away`, 'text-zinc-300', `${dir}/${FILE}`]);
  if (d.left) rows.push([`${d.left} left in Downloads (not sure where they go)`, 'text-zinc-500']);
  if (!rows.length) rows.push(['Downloads is tidy.', 'text-zinc-500']);
  return (
    <Card title="Daily brief">
      <ul className="space-y-1">
        {rows.map(([text, cls, path], i) => (
          <li key={i}>
            <button disabled={!path} onClick={() => path && reveal(path)} title={path ? 'Show in folder' : undefined}
              className={`text-left text-sm ${cls} ${path ? 'hover:underline' : 'cursor-default'}`}>
              {text}
            </button>
          </li>
        ))}
      </ul>
      <p className="text-xs text-zinc-600 mt-2">
        Sorted {d.moved ?? 0} last run{b.t ? ` · ${ago(b.t)}` : ''}
        {dir && <> · <button className="hover:text-zinc-300 underline" onClick={() => reveal(`${dir}/BRIEF.md`)}>Open brief</button></>}
      </p>
    </Card>
  );
});

/* ---------- Notes scratchpad ---------- */
export const NotesCard = memo(function NotesCard() {
  const [text, setText] = usePersisted('notes', '');
  return (
    <Card title="Scratchpad">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Quick notes, saved on this device…"
        spellCheck={false}
        className="w-full h-24 resize-none bg-transparent text-sm text-zinc-300 placeholder-zinc-600 focus:outline-none"
      />
    </Card>
  );
});

/* ---------- Focus timer ---------- */
const MINS = [15, 25, 50];
export const FocusCard = memo(function FocusCard({ toast }: { toast: (m: string) => void }) {
  const [mins, setMins] = useState(25);
  const [left, setLeft] = useState(25 * 60);
  const [running, setRunning] = useState(false);
  const endAt = useRef(0);
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => {
      const l = Math.max(0, Math.round((endAt.current - Date.now()) / 1000));
      setLeft(l);
      if (l === 0) {
        setRunning(false);
        toast('Focus session done');
      }
    }, 500);
    return () => window.clearInterval(id);
  }, [running, toast]);
  const toggle = useCallback(() => {
    if (!running) endAt.current = Date.now() + left * 1000;
    setRunning((r) => !r);
  }, [running, left]);
  const pick = (m: number) => {
    setMins(m);
    setLeft(m * 60);
    setRunning(false);
  };
  const mm = String(Math.floor(left / 60)).padStart(2, '0'), ss = String(left % 60).padStart(2, '0');
  return (
    <Card title="Focus">
      <div className="flex items-center gap-3">
        <div className="text-3xl font-light tabular-nums text-zinc-100">{mm}:{ss}</div>
        <button className={iconBtn} onClick={toggle} title={running ? 'Pause' : 'Start'}>
          {running ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
        </button>
        <button className={iconBtn} onClick={() => pick(mins)} title="Reset"><RotateCcw className="w-4 h-4" /></button>
      </div>
      <div className="flex gap-1 mt-2">
        {MINS.map((m) => (
          <button key={m} onClick={() => pick(m)}
            className={`text-xs px-2 py-0.5 rounded ${m === mins ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'}`}>
            {m}m
          </button>
        ))}
      </div>
    </Card>
  );
});
