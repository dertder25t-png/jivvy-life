import React, { useEffect, useState } from 'react';
import { X, Database } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useWorkspaceStore } from '../store/workspaceStore';
import { api, getApiBase, setApiBase, getSession, API_CONFIG_EVENT, Session } from '../services/apiClient';
import { storageService, getSyncStatus, SYNC_STATUS_EVENT, SyncStatus } from '../services/storageService';

const Toggle: React.FC<{ label: string; checked: boolean; onChange: (v: boolean) => void }> = ({ label, checked, onChange }) => (
  <label className="flex items-center justify-between text-xs text-zinc-300 cursor-pointer">
    <span>{label}</span>
    <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-indigo-500 w-4 h-4" />
  </label>
);

export const SettingsModal: React.FC = () => {
  const { settingsModalOpen, setSettingsModalOpen, showTopBar, setShowTopBar, clearTabsOnStart, setClearTabsOnStart, autoHideAddressBar, setAutoHideAddressBar } =
    useWorkspaceStore();
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
  const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  const loginCall = async (fn: () => Promise<string>) => {
    setLoginMsg('Working...');
    try {
      setLoginMsg(await fn());
    } catch (e) {
      setLoginMsg(`Failed: ${String(e)}`);
    }
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
          <Toggle label="Show top bar" checked={showTopBar} onChange={setShowTopBar} />
          <Toggle label="Auto-hide address bar (hover the top edge to show it)" checked={autoHideAddressBar} onChange={setAutoHideAddressBar} />
          <Toggle label="Clear tabs when the app starts" checked={clearTabsOnStart} onChange={setClearTabsOnStart} />
        </div>

        <div className="space-y-2">
          <h4 className="text-xs font-semibold text-zinc-200">Sync</h4>
          <label className="block text-xs text-zinc-400">API base URL</label>
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            onBlur={() => setApiBase(baseUrl)}
            placeholder="http://127.0.0.1:4000"
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

        {inTauri && (
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
