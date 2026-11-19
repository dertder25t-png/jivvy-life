import { invoke } from '@tauri-apps/api/core';

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/;
export const MAX_BLOCK_SITES = 500;

/** Normalize a URL or host to a bare lowercase hostname, or null if it is not a valid domain. */
export function normalizeHost(input: string): string | null {
  let s = (input || '').trim().toLowerCase();
  if (!s) return null;
  if (!s.includes('://')) s = `https://${s}`;
  let host: string;
  try {
    host = new URL(s).hostname;
  } catch {
    return null;
  }
  host = host.replace(/^www\./, '').replace(/\.$/, '');
  return DOMAIN_RE.test(host) ? host : null;
}

export const inTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** Push blocking settings to the native side (no-op outside Tauri). */
export function pushBlocking(enabled: boolean, disabledSites: string[]) {
  if (!inTauri()) return;
  void invoke('set_blocking', { enabled, disabledSites }).catch(() => {});
}
