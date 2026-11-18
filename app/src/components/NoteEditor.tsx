import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { autocompletion } from '@codemirror/autocomplete';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { Link2, Hash, ChevronDown } from 'lucide-react';
import { useWorkspaceStore } from '../store/workspaceStore';
import { NoteDocument } from '../types/workspace';
import { noteTheme, noteHighlight, decorationExtensions, wikiClickExtension, wikiCompletion } from './notes/editorExtensions';

const SAVE_DEBOUNCE_MS = 400;

const openNoteByTitle = (target: string) => {
  const st = useWorkspaceStore.getState();
  const lower = target.toLowerCase();
  const existing = st.notes.find((n) => n.title.toLowerCase() === lower);
  if (!existing) {
    st.createNote(target); // creates the note and opens its tab
    return;
  }
  openNoteTab(existing.id);
};

function openNoteTab(noteId: string) {
  const st = useWorkspaceStore.getState();
  const ws = st.workspaces.find((w) => w.id === st.activeWorkspaceId);
  const tab = ws?.tabs.find((t) => t.type === 'note' && t.noteId === noteId);
  if (tab) st.focusTab(tab.id);
  else st.openTab({ title: st.notes.find((n) => n.id === noteId)?.title ?? 'Note', type: 'note', noteId });
}

interface BodyProps {
  note: NoteDocument;
  notes: NoteDocument[];
}

const countWords = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);
const timeAgo = (iso: string) => {
  const d = new Date(iso);
  const secs = (Date.now() - d.getTime()) / 1000;
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

// Keyed by note id: the editor owns its text while mounted, so store updates never reset the caret.
const NoteEditorBody = React.memo(({ note, notes }: BodyProps) => {
  const updateNoteContent = useWorkspaceStore((s) => s.updateNoteContent);
  const renameNote = useWorkspaceStore((s) => s.renameNote);
  const [initial] = useState(note.content);
  const pending = useRef<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const [showBacklinks, setShowBacklinks] = useState(false);
  const [saving, setSaving] = useState(false);
  const [title, setTitle] = useState(note.title);
  const [words, setWords] = useState(() => countWords(note.content));

  const flush = useCallback(() => {
    if (timer.current !== undefined) {
      window.clearTimeout(timer.current);
      timer.current = undefined;
    }
    if (pending.current !== null) {
      updateNoteContent(note.id, pending.current);
      pending.current = null;
    }
    setSaving(false);
  }, [note.id, updateNoteContent]);

  const handleChange = useCallback(
    (value: string) => {
      pending.current = value; // no store write per keystroke
      setSaving(true);
      setWords(countWords(value));
      if (timer.current !== undefined) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(flush, SAVE_DEBOUNCE_MS);
    },
    [flush]
  );

  // Save anything still pending when the note changes or the pane unmounts.
  useEffect(() => () => { flush(); }, [flush]);

  const notesRef = useRef(notes);
  notesRef.current = notes;
  const extensions = useMemo(
    () => [
      markdown(),
      noteTheme,
      noteHighlight,
      EditorView.lineWrapping,
      ...decorationExtensions,
      autocompletion({ override: [wikiCompletion(() => notesRef.current.map((n) => n.title))], icons: false }),
      wikiClickExtension((t) => openNoteByTitle(t)),
    ],
    []
  );

  const commitTitle = () => {
    const next = title.trim();
    if (!next) setTitle(note.title);
    else if (next !== note.title) renameNote(note.id, next);
  };

  const backlinks = useMemo(() => {
    const t = note.title.toLowerCase();
    return notes.filter((n) => n.id !== note.id && n.wikilinks.some((w) => w.toLowerCase() === t));
  }, [notes, note.id, note.title]);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="shrink-0 w-full max-w-[720px] mx-auto px-6 pt-8 pb-2">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') { setTitle(note.title); (e.target as HTMLInputElement).blur(); }
          }}
          placeholder="Untitled"
          spellCheck={false}
          className="w-full bg-transparent border-0 outline-none text-3xl font-bold tracking-tight text-zinc-50 placeholder:text-zinc-700"
        />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 mt-2 text-xs text-zinc-500">
          {note.tags.map((tag) => (
            <span key={tag} className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full bg-zinc-900 border border-zinc-800 text-zinc-400">
              <Hash className="w-2.5 h-2.5 text-zinc-600" />
              {tag}
            </span>
          ))}
          <span>{words} {words === 1 ? 'word' : 'words'}</span>
          <span className={saving ? 'text-amber-400/80' : ''}>{saving ? 'Saving…' : 'Saved'}</span>
          {/* Seed notes carry an epoch timestamp (so they never overwrite synced data): no date to show. */}
          {Date.parse(note.updatedAt) > 0 && <span>Updated {timeAgo(note.updatedAt)}</span>}
          {backlinks.length > 0 && (
            <button
              onClick={() => setShowBacklinks((v) => !v)}
              aria-expanded={showBacklinks}
              className="inline-flex items-center gap-1 text-indigo-300 hover:text-indigo-200 transition-colors"
            >
              <Link2 className="w-3 h-3" />
              {backlinks.length} {backlinks.length === 1 ? 'backlink' : 'backlinks'}
              <ChevronDown className={`w-3 h-3 transition-transform ${showBacklinks ? 'rotate-180' : ''}`} />
            </button>
          )}
        </div>
      </div>
      <div className="flex-1 min-h-0">
        <CodeMirror
          value={initial}
          onChange={handleChange}
          extensions={extensions}
          theme="none"
          height="100%"
          basicSetup={{ lineNumbers: false, foldGutter: false, highlightActiveLine: false, highlightActiveLineGutter: false }}
          className="h-full"
        />
      </div>
      {showBacklinks && backlinks.length > 0 && (
        <div className="shrink-0 border-t border-zinc-800/80 bg-zinc-900/40">
          <div className="w-full max-w-[720px] mx-auto px-6 py-3 max-h-40 overflow-y-auto">
            <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1.5">Linked from</div>
            <ul className="flex flex-wrap gap-1.5">
              {backlinks.map((n) => (
                <li key={n.id}>
                  <button
                    onClick={() => openNoteTab(n.id)}
                    className="text-xs text-zinc-300 hover:text-indigo-300 px-2 py-1 rounded bg-zinc-800/70 hover:bg-zinc-800 transition-colors"
                  >
                    {n.title}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
});
NoteEditorBody.displayName = 'NoteEditorBody';

export const NoteEditor: React.FC<{ noteId: string }> = ({ noteId }) => {
  const note = useWorkspaceStore((s) => s.notes.find((n) => n.id === noteId));
  const notes = useWorkspaceStore((s) => s.notes);

  if (!note) {
    return <div className="flex-1 flex items-center justify-center text-sm text-zinc-500">Note not found.</div>;
  }

  return (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col bg-zinc-950">
      <NoteEditorBody key={note.id} note={note} notes={notes} />
    </div>
  );
};
