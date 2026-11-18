// laya = local OpenVINO "vega" reader (helper/laya_server.py on 127.0.0.1:8770).
// Calls go through Rust (laya_classify / laya_health) which does the TCP call with a 1.5 s timeout.
// POST /decide {text} -> {ok, p_ai, ms};  GET /health -> {ok, ready, device, infer_device, ...}
import { invoke } from '@tauri-apps/api/core';

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
    return null; // not running inside Tauri, or command failed
  }
}

export async function layaHealth(): Promise<LayaHealth | null> {
  try {
    return await invoke<LayaHealth | null>('laya_health');
  } catch {
    return null;
  }
}
