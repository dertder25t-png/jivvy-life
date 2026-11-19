import { nativeInvoke, isTauri } from '../platform';
export { normalizeHost, MAX_BLOCK_SITES } from '../../shared/state';

/** Push blocking settings to the Tauri side. Electron's main reads them from its own state. */
export function pushBlocking(enabled: boolean, disabledSites: string[]) {
  if (!isTauri) return;
  void nativeInvoke('set_blocking', { enabled, disabledSites }).catch(() => {});
}
