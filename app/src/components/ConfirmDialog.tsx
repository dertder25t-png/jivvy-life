import React, { useEffect } from 'react';
import { setOverlay } from '../lib/overlay';

interface Props {
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export const ConfirmDialog: React.FC<Props> = ({ title, body, confirmLabel, onConfirm, onCancel }) => {
  useEffect(() => {
    setOverlay('confirm', true);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel();
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      setOverlay('confirm', false);
    };
  }, [onCancel]);

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4" onMouseDown={onCancel}>
      <div
        className="bg-zinc-900 border border-zinc-800 rounded-xl w-full max-w-sm p-5 space-y-3"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h3 className="font-semibold text-sm text-zinc-100">{title}</h3>
        <p className="text-xs text-zinc-400">{body}</p>
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onCancel} className="px-3 py-1.5 text-xs rounded-lg text-zinc-300 hover:bg-zinc-800">
            Cancel
          </button>
          <button
            autoFocus
            onClick={onConfirm}
            className="px-3 py-1.5 text-xs rounded-lg bg-red-600 text-white hover:bg-red-500"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
