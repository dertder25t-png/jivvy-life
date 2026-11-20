import React, { useCallback, useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { X, Database } from 'lucide-react';
import { nativeInvoke as invoke, isTauri, isNative, isElectron, jivvy } from '../platform';
import { usePredictions } from '../lib/predictions';
import type { HistoryClearRange, ImportStatus, MemoryStatus } from '../../shared/ipc';
import { MAX_AWAKE_MAX, MAX_AWAKE_MIN, type PromptPermission } from '../../shared/state';
import type { BenchResult } from '../../shared/lifeboard/bench';
import { nightly } from '../../shared/lifeboard/evallog';
import type { EvalLine } from '../../shared/lifeboard/evallog';
import type { SnapshotEval } from '../../shared/history-types';
import { getVersion } from '@tauri-apps/api/app';
import { check, Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { useWorkspaceStore } from '../store/workspaceStore';
import { normalizeHost } from '../services/blocking';
import { api, getApiBase, setApiBase, getSession, API_CONFIG_EVENT, Session } from '../services/apiClient';
import { storageService, getSyncStatus, SYNC_STATUS_EVENT, SyncStatus } from '../services/storageService';

const Toggle: React.FC<{ label: string; checked: boolean; onChange: (v: boolean) => void }> = ({ label, checked, onChange }) => (
  <label className="flex items-center justify-between text-xs text-zinc-300 cursor-pointer">
    <span>{label}</span>
    <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-indigo-500 w-4 h-4" />
  </label>
);

const PERM_LABEL: Record<string, string> = {
  camera: 'Camera',
  microphone: 'Microphone',
  geolocation: 'Location',
  notifications: 'Notifications',
  'clipboard-read': 'Clipboard (read)',
  midi: 'MIDI devices',
};

/** Electron: what each site was allowed or blocked from using; removing a row makes it ask again. */
const SitePermissionsSection: React.FC = () => {
  const sitePermissions = useWorkspaceStore((st) => st.sitePermissions);
  const remove = useWorkspaceStore((st) => st.removeSitePermission);
  const origins = Object.keys(sitePermissions);
  return (
    <div className="space-y-2 border-t border-zinc-800 pt-3" data-site-permissions>
      <h4 className="text-xs font-semibold text-zinc-200">Site permissions</h4>
      <p className="text-xs text-zinc-500">Sites ask before using your camera, microphone, location, notifications, clipboard or MIDI. Remove an entry and the site will ask again.</p>
      {origins.length === 0 && <p className="text-xs text-zinc-500">No saved decisions.</p>}
      {origins.map((origin) => (
        <div key={origin} className="text-xs text-zinc-300 bg-zinc-900 rounded px-2 py-1.5 space-y-1">
          <div className="flex items-center justify-between">
            <span className="truncate font-medium">{origin.replace(/^https?:\/\//, '')}</span>
            <button onClick={() => remove(origin)} title="Forget every decision for this site" className="text-zinc-400 hover:text-zinc-100 text-[11px] shrink-0 ml-2">
              Remove all
            </button>
          </div>
          {Object.entries(sitePermissions[origin]).map(([perm, decision]) => (
            <div key={perm} data-site-permission={`${origin}|${perm}`} className="flex items-center justify-between pl-2">
              <span>
                {PERM_LABEL[perm] ?? perm}: <span className={decision === 'allow' ? 'text-emerald-300' : 'text-red-300'}>{decision === 'allow' ? 'Allowed' : 'Blocked'}</span>
              </span>
              <button onClick={() => remove(origin, perm as PromptPermission)} title={`Forget ${PERM_LABEL[perm] ?? perm} for this site`} className="text-zinc-400 hover:text-zinc-100">
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
};

const SLEEP_LABELS: Array<[number, string]> = [[5, '5 minutes'], [15, '15 minutes'], [30, '30 minutes'], [60, '1 hour'], [0, 'Never']];

/** Electron memory saver: policies plus live numbers from main. */
const MemorySection: React.FC = () => {
  const { sleepAfterMin, maxAwakeTabs, memoryGuard, keepPinnedAwake, setSleepAfterMin, setMaxAwakeTabs, setMemoryGuard, setKeepPinnedAwake } = useWorkspaceStore(
    useShallow((st) => ({ sleepAfterMin: st.sleepAfterMin, maxAwakeTabs: st.maxAwakeTabs, memoryGuard: st.memoryGuard, keepPinnedAwake: st.keepPinnedAwake, setSleepAfterMin: st.setSleepAfterMin, setMaxAwakeTabs: st.setMaxAwakeTabs, setMemoryGuard: st.setMemoryGuard, setKeepPinnedAwake: st.setKeepPinnedAwake }))
  );
  const [mem, setMem] = useState<MemoryStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const refresh = useCallback(() => invoke<MemoryStatus>('memory_status').then(setMem).catch(() => {}), []);
  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => void refresh(), 2000);
    return () => window.clearInterval(t);
  }, [refresh]);
  const sleepAll = async () => {
    setBusy(true);
    try {
      const n = await invoke<number>('sleep_background');
      setMsg(n ? `Put ${n} tab${n === 1 ? '' : 's'} to sleep.` : 'No background tabs could sleep (active, audible, pinned or unsaved tabs stay awake).');
      await refresh();
    } catch {
      setMsg('Could not sleep tabs.');
    } finally {
      setBusy(false);
    }
  };
  const sel = 'bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-xs text-zinc-100 focus:outline-none focus:border-indigo-500';
  return (
    <div className="space-y-2 border-t border-zinc-800 pt-3" data-section="memory">
      <h4 className="text-xs font-semibold text-zinc-200">Memory</h4>
      <label className="flex items-center justify-between text-xs text-zinc-300">
        <span>Sleep tabs after</span>
        <select aria-label="Sleep tabs after" value={sleepAfterMin} onChange={(e) => setSleepAfterMin(Number(e.target.value))} className={sel}>
          {SLEEP_LABELS.map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>
      </label>
      <label className="flex items-center justify-between text-xs text-zinc-300">
        <span>Max awake tabs</span>
        <span className="flex items-center gap-2">
          <input aria-label="Max awake tabs" type="range" min={MAX_AWAKE_MIN} max={MAX_AWAKE_MAX} value={maxAwakeTabs} onChange={(e) => setMaxAwakeTabs(Number(e.target.value))} className="accent-indigo-500 w-28" />
          <span className="w-5 text-right tabular-nums">{maxAwakeTabs}</span>
        </span>
      </label>
      <Toggle label="Sleep background tabs when memory runs low" checked={memoryGuard} onChange={setMemoryGuard} />
      <Toggle label="Keep pinned tabs awake" checked={keepPinnedAwake} onChange={setKeepPinnedAwake} />
      <p className="text-xs text-zinc-500">Sleeping tabs keep their place and wake where you left off. Tabs playing audio, with unsaved typing, or in fullscreen never sleep.</p>
      <div className="text-xs text-zinc-300 bg-zinc-900 rounded px-2 py-1.5 space-y-0.5">
        <div className="flex justify-between"><span>App memory</span><span className="tabular-nums">{mem ? `${mem.totalMB.toLocaleString()} MB` : '...'}</span></div>
        <div className="flex justify-between"><span>Tabs awake / sleeping</span><span className="tabular-nums">{mem ? `${mem.awake} / ${mem.sleeping}` : '...'}</span></div>
        {mem?.availableMB != null && <div className="flex justify-between"><span>System memory available</span><span className="tabular-nums">{mem.availableMB.toLocaleString()} MB</span></div>}
      </div>
      <button disabled={busy} onClick={() => void sleepAll()} className="px-3 py-1.5 text-xs rounded-lg bg-zinc-800 text-zinc-100 hover:bg-zinc-700 disabled:opacity-50">
        Sleep all background tabs now
      </button>
      {msg && <p className="text-xs text-indigo-300">{msg}</p>}
    </div>
  );
};

export const SettingsModal: React.FC = () => {
  // Pick only what this modal shows (a bare useWorkspaceStore() re-renders on every store patch).
  const { settingsModalOpen, setSettingsModalOpen, showTopBar, setShowTopBar, saveHistory, setSaveHistory, clearTabsOnStart, setClearTabsOnStart, autoHideAddressBar, setAutoHideAddressBar, showFolders, setShowFolders, zenBarPosition, setZenBarPosition, blockingEnabled, setBlockingEnabled, blockingDisabledSites, setBlockingDisabledSites } = useWorkspaceStore(
    useShallow((st) => ({ settingsModalOpen: st.settingsModalOpen, setSettingsModalOpen: st.setSettingsModalOpen, showTopBar: st.showTopBar, setShowTopBar: st.setShowTopBar, saveHistory: st.saveHistory, setSaveHistory: st.setSaveHistory, clearTabsOnStart: st.clearTabsOnStart, setClearTabsOnStart: st.setClearTabsOnStart, autoHideAddressBar: st.autoHideAddressBar, setAutoHideAddressBar: st.setAutoHideAddressBar, showFolders: st.showFolders, setShowFolders: st.setShowFolders, zenBarPosition: st.zenBarPosition, setZenBarPosition: st.setZenBarPosition, blockingEnabled: st.blockingEnabled, setBlockingEnabled: st.setBlockingEnabled, blockingDisabledSites: st.blockingDisabledSites, setBlockingDisabledSites: st.setBlockingDisabledSites }))
  );
  const [baseUrl, setBaseUrl] = useState(getApiBase());
  const [session, setSessionState] = useState<Session | null>(getSession());
  const [syncStatus, setSyncStatusState] = useState<SyncStatus>(getSyncStatus());
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState(''); // component state only, never persisted
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  useEffect(() => {
    const onCfg = () => setSessionState(getSession());
    const onStatus = () => setSyncStatusState(getSyncStatus());
    window.addEventListener(API_CONFIG_EVENT, onCfg);
    window.addEventListener(SYNC_STATUS_EVENT, onStatus);
    return () => {
      window.removeEventListener(API_CONFIG_EVENT, onCfg);
      window.removeEventListener(SYNC_STATUS_EVENT, onStatus);
    };
  }, []);
  const [loginMsg, setLoginMsg] = useState('');
  const [blockStatus, setBlockStatus] = useState<{ ready: boolean; rules: number; enabled: boolean } | null>(null);
  const [siteInput, setSiteInput] = useState('');
  const [siteErr, setSiteErr] = useState('');
  const addSite = () => {
    const h = normalizeHost(siteInput);
    if (!h) {
      setSiteErr('Enter a valid site like example.com');
      return;
    }
    setSiteErr('');
    setSiteInput('');
    if (!blockingDisabledSites.includes(h)) setBlockingDisabledSites([...blockingDisabledSites, h]);
  };
  const inTauri = isTauri;
  const [installKind, setInstallKind] = useState<'appimage' | 'native' | ''>('');
  const [appVersion, setAppVersion] = useState('');
  const [update, setUpdate] = useState<Update | null>(null);
  const [updMsg, setUpdMsg] = useState('');
  const [updBusy, setUpdBusy] = useState(false);
  const checkUpdates = async () => {
    setUpdBusy(true);
    setUpdMsg('Checking...');
    try {
      const u = await check();
      setUpdate(u);
      setUpdMsg(u ? '' : 'You are up to date.');
    } catch {
      setUpdate(null);
      setUpdMsg('Could not check for updates. Updates work in the installed AppImage build.');
    } finally {
      setUpdBusy(false);
    }
  };
  const installUpdate = async () => {
    if (!update) return;
    setUpdBusy(true);
    let total = 0;
    let got = 0;
    setUpdMsg('Downloading...');
    try {
      await update.downloadAndInstall((ev) => {
        if (ev.event === 'Started') total = ev.data.contentLength ?? 0;
        else if (ev.event === 'Progress') {
          got += ev.data.chunkLength;
          setUpdMsg(total ? `Downloading... ${Math.round((got / total) * 100)}%` : `Downloading... ${Math.round(got / 1024)} KB`);
        } else if (ev.event === 'Finished') setUpdMsg('Installing...');
      });
      setUpdMsg('Restarting...');
      await relaunch();
    } catch (e) {
      setUpdMsg(`Update failed: ${e instanceof Error ? e.message : String(e)}. Updates work in the installed AppImage build.`);
      setUpdBusy(false);
    }
  };
  useEffect(() => {
    if (!settingsModalOpen || !inTauri) return;
    getVersion().then(setAppVersion).catch(() => {});
    invoke<string>('install_kind')
      .then((k) => {
        setInstallKind(k === 'appimage' ? 'appimage' : 'native');
        if (k === 'appimage') void checkUpdates();
      })
      .catch(() => setInstallKind('native'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsModalOpen]);
  useEffect(() => {
    if (!settingsModalOpen || !isNative) return;
    let live = true;
    const poll = () =>
      invoke<{ ready: boolean; rules: number; enabled: boolean }>('blocking_status')
        .then((s) => {
          if (!live) return;
          setBlockStatus(s);
          if (!s.ready) setTimeout(poll, 1500);
        })
        .catch(() => {});
    void poll();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsModalOpen]);
  const loginCall = async (fn: () => Promise<string>) => {
    setLoginMsg('Working...');
    try {
      setLoginMsg(await fn());
    } catch (e) {
      setLoginMsg(`Failed: ${String(e)}`);
    }
  };

  const snap = usePredictions();
  const [histMsg, setHistMsg] = useState('');
  // One heavy job at a time (import, retrain, benchmark): every button shows "Working…" and clicks are ignored.
  const [op, setOp] = useState<null | 'import' | 'train' | 'bench'>(null);
  const opRef = React.useRef<typeof op>(null);
  const begin = (o: NonNullable<typeof op>) => {
    if (opRef.current) return false;
    opRef.current = o;
    setOp(o);
    return true;
  };
  const end = () => {
    opRef.current = null;
    setOp(null);
  };
  useEffect(() => {
    // Main pushes import progress (<= 4/s); no polling.
    if (!jivvy) return;
    return jivvy.onHistoryImportStatus((s: ImportStatus) => {
      if (s.state === 'running') setHistMsg(`Importing… ${s.imported.toLocaleString()} visits so far`);
    });
  }, []);
  const importFirefox = async () => {
    if (!jivvy || !begin('import')) return;
    setHistMsg('Importing Firefox history…');
    try {
      const r = await jivvy.historyImportFirefox();
      if (r.state === 'done') {
        setHistMsg(`Imported ${r.imported.toLocaleString()} visits (${r.skipped.toLocaleString()} skipped). Retraining suggestions…`);
        await jivvy.predictionsTrain(); // joins the retrain main started after the import
        setHistMsg(`Imported ${r.imported.toLocaleString()} visits (${r.skipped.toLocaleString()} skipped). Suggestions retrained.`);
      } else setHistMsg(`Import failed: ${r.error || 'unknown error'}`);
    } catch (e) {
      setHistMsg(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      end();
    }
  };
  const retrain = async () => {
    if (!jivvy || !begin('train')) return;
    setHistMsg('Training…');
    try {
      setHistMsg((await jivvy.predictionsTrain()) ? 'Trained.' : 'Training failed. See the log.');
    } finally {
      end();
    }
  };
  const [bench, setBench] = useState<BenchResult | null>(null);
  const [evalLog, setEvalLog] = useState<EvalLine[]>([]);
  useEffect(() => {
    if (!jivvy || !settingsModalOpen) return;
    void jivvy.predictionsEvalLog().then(setEvalLog, () => undefined);
  }, [settingsModalOpen, snap?.trainedAt]);
  const runBench = async () => {
    if (!jivvy || !begin('bench')) return;
    setHistMsg('Running search benchmark…');
    try {
      const r = await jivvy.predictionsBench();
      setBench(r);
      setHistMsg(r ? '' : 'Benchmark failed. See the log.');
    } finally {
      end();
    }
  };
  const clearHistory = async (range: HistoryClearRange) => {
    if (!jivvy) return;
    if (range === 'all' && !window.confirm('Delete all browsing history? Suggestions will be reset too.')) return;
    const n = await jivvy.historyClear(range);
    setHistMsg(`Cleared ${n.toLocaleString()} visits.`);
  };

  if (!settingsModalOpen) return null;

  const run = async (fn: () => Promise<string | void>) => {
    setBusy(true);
    setStatus('Working...');
    try {
      setStatus((await fn()) || '');
    } catch (e) {
      setStatus(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };
  const auth = (mode: 'login' | 'signup') =>
    run(async () => {
      setApiBase(baseUrl);
      await (mode === 'login' ? api.login(email.trim(), password) : api.signup(email.trim(), password));
      setPassword('');
      return mode === 'login' ? 'Logged in.' : 'Account created.';
    });

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl w-full max-w-md p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-zinc-100 flex items-center gap-2">
            <Database className="w-4 h-4 text-emerald-400" /> Settings
          </h3>
          <button onClick={() => setSettingsModalOpen(false)} className="text-zinc-400 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="space-y-2 pb-3 border-b border-zinc-800">
          {!isElectron && <Toggle label="Show top bar" checked={showTopBar} onChange={setShowTopBar} />}
          <Toggle label="Show folders in sidebar" checked={showFolders} onChange={setShowFolders} />
          <Toggle label="Auto-hide address bar (hover the top edge to show it)" checked={autoHideAddressBar} onChange={setAutoHideAddressBar} />
          <Toggle label="Clear tabs when the app starts" checked={clearTabsOnStart} onChange={setClearTabsOnStart} />
          <div className="flex items-center justify-between text-xs text-zinc-300 pt-1">
            <span>Zen mode hover bar edge</span>
            <select
              value={zenBarPosition}
              onChange={(e) => setZenBarPosition(e.target.value as 'left' | 'top' | 'bottom')}
              className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-xs text-zinc-100"
            >
              <option value="left">Left (Compact without icons)</option>
              <option value="top">Top edge</option>
              <option value="bottom">Bottom edge</option>
            </select>
          </div>
        </div>

        <div className="space-y-2">
          <h4 className="text-xs font-semibold text-zinc-200">Sync</h4>
          <label className="block text-xs text-zinc-400">API base URL</label>
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            onBlur={() => setApiBase(baseUrl)}
            placeholder="https://staging-jivvy-life-api-ei5i.encr.app"
            className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-1.5 text-xs text-zinc-100"
          />
          {session ? (
            <div className="space-y-2">
              <p className="text-xs text-zinc-300">
                Signed in as <span className="text-emerald-400">{session.email}</span>
              </p>
              <div className="flex gap-2">
                <button
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      await storageService.syncNow();
                    })
                  }
                  className="px-3 py-1.5 text-xs rounded-lg bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50"
                >
                  Sync now
                </button>
                <button disabled={busy} onClick={() => run(async () => void (await api.logout()))} className="px-3 py-1.5 text-xs rounded-lg bg-zinc-800 text-zinc-100 hover:bg-zinc-700 disabled:opacity-50">
                  Log out
                </button>
              </div>
              <p className="text-xs text-zinc-400">
                {syncStatus.at
                  ? `Last sync ${new Date(syncStatus.at).toLocaleString()}: ${syncStatus.ok ? 'OK' : syncStatus.message}`
                  : 'Not synced yet'}
              </p>
            </div>
          ) : (
            <form
              className="space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                void auth('login');
              }}
            >
              <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-1.5 text-xs text-zinc-100" />
              <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-1.5 text-xs text-zinc-100" />
              <div className="flex gap-2">
                <button type="submit" disabled={busy || !email || !password} className="px-3 py-1.5 text-xs rounded-lg bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50">
                  Log in
                </button>
                <button type="button" disabled={busy || !email || !password} onClick={() => void auth('signup')} className="px-3 py-1.5 text-xs rounded-lg bg-zinc-800 text-zinc-100 hover:bg-zinc-700 disabled:opacity-50">
                  Sign up
                </button>
              </div>
              <p className="text-xs text-zinc-500">Not signed in: everything stays local on this device.</p>
            </form>
          )}
        </div>

        {inTauri && installKind === 'native' && (
          <div className="border-t border-zinc-800 pt-3">
            <p className="text-xs text-zinc-400">
              Installed from source. Update with <code className="text-zinc-300">npm run app:install</code>.
            </p>
          </div>
        )}

        {inTauri && installKind === 'appimage' && (
          <div className="space-y-2 border-t border-zinc-800 pt-3">
            <h4 className="text-xs font-semibold text-zinc-200">Updates</h4>
            <p className="text-xs text-zinc-400">Current version {appVersion || '...'}</p>
            {update && (
              <div className="space-y-1">
                <p className="text-xs text-emerald-400">Version {update.version} is available.</p>
                {update.body && <p className="text-xs text-zinc-400 whitespace-pre-wrap max-h-24 overflow-auto">{update.body}</p>}
              </div>
            )}
            <div className="flex gap-2">
              <button disabled={updBusy} onClick={() => void checkUpdates()} className="px-3 py-1.5 text-xs rounded-lg bg-zinc-800 text-zinc-100 hover:bg-zinc-700 disabled:opacity-50">
                Check for updates
              </button>
              {update && (
                <button disabled={updBusy} onClick={() => void installUpdate()} className="px-3 py-1.5 text-xs rounded-lg bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50">
                  Update &amp; restart
                </button>
              )}
            </div>
            {updMsg && <p className="text-xs text-zinc-400">{updMsg}</p>}
          </div>
        )}

        {isElectron && (
          <div className="space-y-2 border-t border-zinc-800 pt-3" data-section="history">
            <h4 className="text-xs font-semibold text-zinc-200">History &amp; predictions</h4>
            <Toggle label="Save browsing history" checked={saveHistory} onChange={setSaveHistory} />
            <p className="text-xs text-zinc-500">Kept only on this computer. It powers address suggestions and shortcuts.</p>
            <div className="flex flex-wrap gap-2">
              <button data-action="import" disabled={!!op} onClick={() => void importFirefox()} className="px-3 py-1.5 text-xs rounded-lg bg-zinc-800 text-zinc-100 hover:bg-zinc-700 disabled:opacity-50">
                {op ? 'Working…' : 'Import Firefox history'}
              </button>
              <button data-action="retrain" disabled={!!op} onClick={() => void retrain()} className="px-3 py-1.5 text-xs rounded-lg bg-zinc-800 text-zinc-100 hover:bg-zinc-700 disabled:opacity-50">
                {op ? 'Working…' : 'Retrain now'}
              </button>
              <button data-action="bench" disabled={!!op} onClick={() => void runBench()} className="px-3 py-1.5 text-xs rounded-lg bg-zinc-800 text-zinc-100 hover:bg-zinc-700 disabled:opacity-50">
                {op ? 'Working…' : 'Run search benchmark'}
              </button>
            </div>
            <p className="text-xs text-zinc-400" data-last-trained>
              {snap ? `Last trained: ${new Date(snap.trainedAt).toLocaleString()}, ${snap.stats.sites.toLocaleString()} sites, ${snap.stats.aliases.toLocaleString()} shortcuts` : 'Not trained yet.'}
            </p>
            <SearchAccuracy ev={snap?.eval} log={evalLog} />
            {bench && <BenchTable r={bench} />}
            <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-300">
              <span>Clear history:</span>
              {([['hour', 'last hour'], ['day', 'last day'], ['all', 'all']] as const).map(([r, label]) => (
                <button key={r} onClick={() => void clearHistory(r)} className="px-2.5 py-1 text-xs rounded-lg bg-zinc-800 text-red-300 hover:bg-zinc-700">
                  {label}
                </button>
              ))}
            </div>
            {histMsg && <p className="text-xs text-indigo-300">{histMsg}</p>}
          </div>
        )}

        {isElectron && <MemorySection />}

        {isNative && (
          <div className="space-y-2 border-t border-zinc-800 pt-3">
            <h4 className="text-xs font-semibold text-zinc-200">Privacy</h4>
            <Toggle label="Block ads & trackers" checked={blockingEnabled} onChange={setBlockingEnabled} />
            <p className="text-xs text-zinc-500">
              {!blockingEnabled ? 'Blocking is off.' : blockStatus?.ready ? `Blocking ${blockStatus.rules.toLocaleString()} trackers` : 'Getting ready…'}
            </p>
            <div className="text-xs text-zinc-300 space-y-1">
              <span className="block">Sites where blocking is off</span>
              {blockingDisabledSites.length === 0 && <p className="text-zinc-500">None.</p>}
              {blockingDisabledSites.map((h) => (
                <div key={h} className="flex items-center justify-between bg-zinc-900 rounded px-2 py-1">
                  <span>{h}</span>
                  <button onClick={() => setBlockingDisabledSites(blockingDisabledSites.filter((x) => x !== h))} title={`Turn blocking back on for ${h}`} className="text-zinc-400 hover:text-zinc-100">
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  addSite();
                }}
                className="flex gap-2"
              >
                <input
                  value={siteInput}
                  onChange={(e) => setSiteInput(e.target.value)}
                  placeholder="example.com"
                  spellCheck={false}
                  className="flex-1 min-w-0 bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-xs text-zinc-100 focus:outline-none focus:border-indigo-500"
                />
                <button type="submit" className="px-3 py-1 text-xs rounded-lg bg-zinc-800 text-zinc-100 hover:bg-zinc-700">
                  Add
                </button>
              </form>
              {siteErr && <p className="text-red-300">{siteErr}</p>}
            </div>
            <p className="text-[10px] text-zinc-500">Filter lists: EasyList &amp; EasyPrivacy (easylist.to), CC BY-SA 3.0</p>
          </div>
        )}

        {isElectron && <SitePermissionsSection />}

        {isNative && (
          <div className="space-y-2 border-t border-zinc-800 pt-3">
            <h4 className="text-xs font-semibold text-zinc-200">Logins</h4>
            <button
              onClick={() =>
                loginCall(async () => {
                  const r = await invoke<{ imported: number; skipped: number; profile: string }>('import_firefox_cookies');
                  return `Imported ${r.imported} cookies (${r.skipped} skipped) from Firefox profile ${r.profile}. Reload open tabs.`;
                })
              }
              className="px-3 py-1.5 text-xs rounded-lg bg-zinc-800 text-zinc-100 hover:bg-zinc-700"
            >
              Import Firefox sessions
            </button>
            <div className="text-xs text-zinc-300">
              <label className="block mb-1">Import saved passwords (Firefox CSV export)</label>
              <input
                type="file"
                accept=".csv"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (!f) return;
                  void loginCall(async () => {
                    const r = await invoke<{ imported: number; skipped: number }>('import_passwords_csv', { csv: await f.text() });
                    return `Imported ${r.imported} logins (${r.skipped} skipped). Delete the exported CSV file now: it contains your passwords in plain text.`;
                  });
                }}
                className="text-xs text-zinc-400 file:mr-2 file:px-2 file:py-1 file:rounded file:border-0 file:bg-zinc-800 file:text-zinc-200"
              />
            </div>
            <button
              onClick={() => {
                if (window.confirm('Delete all saved passwords from the system keyring?'))
                  void loginCall(async () => `Forgot ${await invoke<number>('forget_all_logins')} saved passwords.`);
              }}
              className="px-3 py-1.5 text-xs rounded-lg bg-zinc-800 text-red-300 hover:bg-zinc-700"
            >
              Forget saved passwords
            </button>
            {loginMsg && <p className="text-xs text-indigo-300">{loginMsg}</p>}
          </div>
        )}

        {status && <p className="text-xs text-indigo-300">{status}</p>}

      </div>
    </div>
  );
};

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const w = 112, h = 24;
  const lo = Math.min(...values), hi = Math.max(...values);
  const span = hi - lo || 1;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * (w - 4) + 2).toFixed(1)},${(h - 3 - ((v - lo) / span) * (h - 6)).toFixed(1)}`).join(' ');
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label="Top-3 accuracy, last 14 nights" data-sparkline>
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" className="text-indigo-300" />
    </svg>
  );
}

const SearchAccuracy = React.memo(function SearchAccuracy({ ev, log }: { ev?: SnapshotEval; log: EvalLine[] }) {
  if (!ev) return <p className="text-xs text-zinc-500">Search accuracy: not measured yet.</p>;
  const m = ev.metrics;
  const nights = nightly(log).slice(-14).map((x) => x.v);
  const arrow = ev.trend == null ? '' : ev.trend > 0.01 ? ' · trend ↑ vs 7 nights ago' : ev.trend < -0.01 ? ' · trend ↓ vs 7 nights ago' : ' · trend → vs 7 nights ago';
  return (
    <div className="space-y-1" data-search-accuracy>
      {ev.status === 'insufficient' || !m ? (
        <p className="text-xs text-zinc-400">Search accuracy: insufficient data ({ev.n} recent typed visits, need 30).</p>
      ) : (
        <p className="text-xs text-zinc-400">
          Search accuracy: top-3 {Math.round(m.top3[1] * 100)}% (2 letters) · saves {Math.round(m.keystrokesSavedPct)}% keystrokes{arrow}
        </p>
      )}
      <p className="text-xs text-zinc-500">
        Last tuning: {ev.status === 'promoted' ? `promoted ${ev.changed.join(', ')}` : ev.status === 'kept' ? `kept current settings${ev.changed.length ? ` (${ev.changed[0]})` : ''}` : 'insufficient data'}
      </p>
      {ev.alert && <p className="text-xs text-amber-300" data-eval-alert>{ev.message || 'Search accuracy has been falling.'}</p>}
      <Sparkline values={nights} />
    </div>
  );
});

const BenchTable = React.memo(function BenchTable({ r }: { r: BenchResult }) {
  const pc = (x: number) => `${Math.round(x * 100)}%`;
  return (
    <div className="space-y-1" data-bench-table>
      <table className="text-xs text-zinc-300 w-full">
        <thead>
          <tr className="text-left text-zinc-500">
            {['params', 'n', 'top-1 @1/2/3', 'top-3 @1/2/3', 'chars', 'saved', 'wrong inline'].map((h) => (
              <th key={h} className="pr-2 font-normal">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {r.rows.map(({ label, metrics: m }) => (
            <tr key={label}>
              <td className="pr-2">{label}</td>
              <td className="pr-2">{m.n}</td>
              <td className="pr-2">{m.top1.map(pc).join(' / ')}</td>
              <td className="pr-2">{m.top3.map(pc).join(' / ')}</td>
              <td className="pr-2">{m.meanCharsToTop1.toFixed(2)}</td>
              <td className="pr-2">{Math.round(m.keystrokesSavedPct)}%</td>
              <td className="pr-2">{pc(m.wrongInlineRate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-zinc-500">
        Tuning would {r.tuning.status === 'promoted' ? `promote ${r.tuning.changed.join(', ')}` : r.tuning.status === 'insufficient' ? 'be skipped (insufficient data)' : 'keep current settings'} ({r.tuning.tuneMs} ms).
      </p>
    </div>
  );
});
