import React, { useEffect, useRef, useState } from 'react';
import { X, Upload, Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';
import { useWorkspaceStore } from '../store/workspaceStore';
import { parseImportFile } from '../services/importService';
import { ImportResult } from '../types/workspace';

type Step = 'pick' | 'parsing' | 'preview' | 'confirm' | 'done' | 'error';

const ACCEPT = '.html,.htm,.sqlite,.sqlite3,.zip,.json';
const btnBase = 'px-3 py-1.5 text-xs rounded-lg disabled:opacity-40';
const btnGhost = `${btnBase} bg-zinc-800 text-zinc-300 hover:bg-zinc-700`;
const btnPrimary = `${btnBase} bg-indigo-600 text-white hover:bg-indigo-500`;

export const ImportWizard: React.FC = () => {
  const { importModalOpen, setImportModalOpen, importData } = useWorkspaceStore();
  const [step, setStep] = useState<Step>('pick');
  const [fileName, setFileName] = useState('');
  const [result, setResult] = useState<ImportResult | null>(null);
  const [includeNotes, setIncludeNotes] = useState(true);
  const [error, setError] = useState('');
  const [summary, setSummary] = useState({ folders: 0, tabs: 0, notes: 0 });
  // Incremented to invalidate in-flight parses (modal closed or user cancelled).
  const runRef = useRef(0);

  // Reset the wizard whenever it closes.
  useEffect(() => {
    if (!importModalOpen) {
      runRef.current++;
      setStep('pick');
      setFileName('');
      setResult(null);
      setIncludeNotes(true);
      setError('');
    }
  }, [importModalOpen]);

  if (!importModalOpen) return null;

  const selectedGroups = result?.workspaces.filter((g) => g.selected) ?? [];
  const selectedTabs = selectedGroups.reduce((sum, g) => sum + g.tabs.length, 0);
  const noteCount = result?.notes.length ?? 0;
  const notesToImport = includeNotes ? noteCount : 0;

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const file = input.files?.[0];
    input.value = ''; // allow re-picking the same file later
    if (!file) return;

    const run = ++runRef.current;
    setFileName(file.name);
    setError('');
    setStep('parsing');

    // Yield so the parsing screen paints before the heavy work begins.
    await new Promise((resolve) => setTimeout(resolve, 50));

    try {
      const parsed = await parseImportFile(file);
      if (run !== runRef.current) return;
      setResult(parsed);
      setIncludeNotes(true);
      setStep('preview');
    } catch (err) {
      if (run !== runRef.current) return;
      setError(err instanceof Error ? err.message : 'Could not read this file.');
      setStep('error');
    }
  };

  const cancelParsing = () => {
    runRef.current++;
    setStep('pick');
  };

  const toggleGroup = (idx: number) => {
    setResult((prev) =>
      prev
        ? {
            ...prev,
            workspaces: prev.workspaces.map((g, i) => (i === idx ? { ...g, selected: !g.selected } : g)),
          }
        : prev
    );
  };

  const setAllGroups = (selected: boolean) => {
    setResult((prev) =>
      prev ? { ...prev, workspaces: prev.workspaces.map((g) => ({ ...g, selected })) } : prev
    );
  };

  const handleConfirm = () => {
    if (!result) return;
    importData(selectedGroups, includeNotes ? result.notes : []);
    setSummary({ folders: selectedGroups.length, tabs: selectedTabs, notes: notesToImport });
    setStep('done');
  };

  const close = () => setImportModalOpen(false);

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl w-full max-w-lg p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-zinc-100 flex items-center gap-2">
            <Upload className="w-4 h-4 text-indigo-400" /> Import Firefox & Google Data
          </h3>
          <button onClick={close} className="text-zinc-400 hover:text-white" aria-label="Close import">
            <X className="w-4 h-4" />
          </button>
        </div>

        {step === 'pick' && (
          <>
            <p className="text-xs text-zinc-400">
              Choose one file: Firefox <code className="text-zinc-200">bookmarks.html</code> or{' '}
              <code className="text-zinc-200">places.sqlite</code> (close Firefox first so it is not locked), or a
              Google Takeout <code className="text-zinc-200">.zip</code> / <code className="text-zinc-200">.json</code>{' '}
              with Keep notes or Chrome bookmarks.
            </p>
            <input
              type="file"
              accept={ACCEPT}
              onChange={handleFile}
              className="block w-full text-xs text-zinc-300 file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:bg-indigo-600 file:text-white hover:file:bg-indigo-500"
            />
            <div className="flex justify-end">
              <button onClick={close} className={btnGhost}>
                Cancel
              </button>
            </div>
          </>
        )}

        {step === 'parsing' && (
          <div className="flex flex-col items-center gap-3 py-6 text-xs text-zinc-300">
            <Loader2 className="w-6 h-6 text-indigo-400 animate-spin" />
            <p>Parsing {fileName}…</p>
            <p className="text-zinc-500">Large files can take a moment.</p>
            <button onClick={cancelParsing} className={btnGhost}>
              Cancel
            </button>
          </div>
        )}

        {step === 'preview' && result && (
          <>
            <div className="flex items-center justify-between text-xs">
              <span className="text-zinc-400">
                {fileName}: {result.workspaces.length} folder(s), {noteCount} note(s)
              </span>
              {result.workspaces.length > 0 && (
                <span className="flex gap-2">
                  <button onClick={() => setAllGroups(true)} className="text-indigo-300 hover:text-indigo-200">
                    All
                  </button>
                  <button onClick={() => setAllGroups(false)} className="text-indigo-300 hover:text-indigo-200">
                    None
                  </button>
                </span>
              )}
            </div>

            {result.workspaces.length > 0 && (
              <div className="max-h-48 overflow-y-auto space-y-1 border border-zinc-800 rounded-lg p-2">
                {result.workspaces.map((g, idx) => (
                  <label
                    key={idx}
                    className="flex items-center justify-between text-xs p-1.5 hover:bg-zinc-800 rounded cursor-pointer"
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <input type="checkbox" checked={g.selected} onChange={() => toggleGroup(idx)} />
                      <span className="truncate">{g.folderName}</span>
                    </span>
                    <span className="text-zinc-500 shrink-0 ml-2">{g.tabs.length} tabs</span>
                  </label>
                ))}
              </div>
            )}

            {result.topDomains.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs text-zinc-400">Top domains by visits</p>
                <ul className="max-h-32 overflow-y-auto text-xs divide-y divide-zinc-800 border border-zinc-800 rounded-lg">
                  {result.topDomains.slice(0, 10).map((d) => (
                    <li key={d.domain} className="flex justify-between px-2 py-1">
                      <span className="text-zinc-200 truncate">{d.domain}</span>
                      <span className="text-zinc-500 shrink-0 ml-2">{d.visits.toLocaleString()}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="flex justify-between items-center gap-2">
              <button onClick={() => setStep('pick')} className={btnGhost}>
                Back
              </button>
              <div className="flex items-center gap-3">
                <span className="text-xs text-zinc-500">
                  {selectedGroups.length} folder(s) · {selectedTabs} tabs selected
                </span>
                <button
                  onClick={() => setStep('confirm')}
                  disabled={selectedGroups.length === 0 && noteCount === 0}
                  className={btnPrimary}
                >
                  Continue
                </button>
              </div>
            </div>
          </>
        )}

        {step === 'confirm' && result && (
          <>
            <p className="text-xs text-zinc-300">
              Merge <strong>{selectedGroups.length}</strong> workspace(s) with <strong>{selectedTabs}</strong> tab(s)
              into your existing workspaces. Current data is kept.
            </p>
            {noteCount > 0 && (
              <label className="flex items-center gap-2 text-xs text-zinc-300">
                <input
                  type="checkbox"
                  checked={includeNotes}
                  onChange={(e) => setIncludeNotes(e.target.checked)}
                />
                Also add {noteCount} note(s) (labels become tags)
              </label>
            )}
            <div className="flex justify-between gap-2">
              <button onClick={() => setStep('preview')} className={btnGhost}>
                Back
              </button>
              <button onClick={handleConfirm} className={btnPrimary}>
                Merge now
              </button>
            </div>
          </>
        )}

        {step === 'done' && (
          <>
            <div className="flex items-center gap-2 text-xs text-emerald-400">
              <CheckCircle2 className="w-4 h-4" />
              Imported {summary.folders} workspace(s), {summary.tabs} tab(s), {summary.notes} note(s).
            </div>
            <div className="flex justify-end">
              <button onClick={close} className={btnPrimary}>
                Done
              </button>
            </div>
          </>
        )}

        {step === 'error' && (
          <>
            <div className="flex items-start gap-2 text-xs text-red-400">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
            <div className="flex justify-between gap-2">
              <button onClick={close} className={btnGhost}>
                Close
              </button>
              <button onClick={() => setStep('pick')} className={btnPrimary}>
                Try again
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
