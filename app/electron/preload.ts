// Preload for the two UI views only (web pages get no preload). Sandboxed, contextIsolation on:
// it exposes a small typed API and nothing from Node.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { CH, type JivvyApi } from '../shared/ipc';

function listen<T>(channel: string, cb: (v: T) => void): () => void {
  const fn = (_e: IpcRendererEvent, v: T) => cb(v);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
}

const api: JivvyApi = {
  init: () => ipcRenderer.invoke(CH.init),
  dispatch: (a) => ipcRenderer.send(CH.dispatch, a),
  onPatch: (cb) => listen(CH.patch, cb),
  tabNav: (tabId, action) => ipcRenderer.send(CH.tabNav, tabId, action),
  setMuted: (tabId, muted) => ipcRenderer.send(CH.setMuted, tabId, muted),
  overlayOpen: (spec) => ipcRenderer.send(CH.overlayOpen, spec),
  overlayClose: (seq) => ipcRenderer.send(CH.overlayClose, seq),
  overlayReady: (seq, rect) => ipcRenderer.send(CH.overlayReady, seq, rect),
  onOverlay: (cb) => listen(CH.overlay, cb),
  emit: (ev) => ipcRenderer.send(CH.emit, ev),
  onEvent: (cb) => listen(CH.event, cb),
  invoke: async <T,>(cmd: string, args?: Record<string, unknown>) => {
    const r = (await ipcRenderer.invoke(CH.invoke, cmd, args ?? {})) as { ok: boolean; value?: T; error?: string };
    if (!r?.ok) throw new Error(r?.error || 'Command failed');
    return r.value as T;
  },
};

contextBridge.exposeInMainWorld('jivvy', api);
