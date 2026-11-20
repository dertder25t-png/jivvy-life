// NOTE: no longer used by the dashboard search box or the address bars (they route with the ported
// Lifeboard decide()/complete() in shared/lifeboard, see src/lib/predictions.ts). The laya/NPU
// helper stays installed for future features; nothing on disk was removed.
// laya = local OpenVINO "vega" reader (helper/laya_server.py on 127.0.0.1:8770).
// The Electron build answers laya_classify / laya_health with null for now.
// POST /decide {text} -> {ok, p_ai, ms};  GET /health -> {ok, ready, device, infer_device, ...}
import { nativeInvoke as invoke } from '../../platform';

export interface LayaOut {
  ok: boolean;
  p_ai: number;
  ms?: number;
}
export interface LayaHealth {
  ok: boolean;
  ready: boolean;
  model?: string;
  device?: string;
  infer_device?: string;
}

export async function layaClassify(text: string): Promise<LayaOut | null> {
  try {
    const o = await invoke<LayaOut | null>('laya_classify', { text });
    return o && typeof o.p_ai === 'number' ? o : null;
  } catch {
    return null; // not running inside the desktop app, or command failed
  }
}

export async function layaHealth(): Promise<LayaHealth | null> {
  try {
    return await invoke<LayaHealth | null>('laya_health');
  } catch {
    return null;
  }
}
