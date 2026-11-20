// Ad & tracker blocking for the page session. The EasyList/EasyPrivacy domain rules from
// blocklist/blocklist.json are extracted at build time into a flat domain list
// (dist-electron/blocklist-domains.json); here they become Sets and every request is checked
// by walking its host's labels: O(labels), no regex.
import fs from 'node:fs';
import path from 'node:path';
import type { Session } from 'electron';

const log = (...a: unknown[]) => console.error('[blocking]', ...a);

/** Fast host extraction without URL parsing: scheme://[user@]host[:port]/... */
export function hostOf(url: string): string | null {
  const s = url.indexOf('://');
  if (s < 0) return null;
  let i = s + 3;
  let end = url.length;
  for (let j = i; j < url.length; j++) {
    const c = url.charCodeAt(j);
    if (c === 47 /* / */ || c === 63 /* ? */ || c === 35 /* # */) {
      end = j;
      break;
    }
  }
  let host = url.slice(i, end);
  const at = host.lastIndexOf('@');
  if (at >= 0) host = host.slice(at + 1);
  if (host.startsWith('[')) return host.slice(0, host.indexOf(']') + 1).toLowerCase();
  const colon = host.indexOf(':');
  if (colon >= 0) host = host.slice(0, colon);
  if (host.endsWith('.')) host = host.slice(0, -1);
  return host ? host.toLowerCase() : null;
}

/** True when `host` or one of its parent domains is in `set`. */
export function inSet(set: Set<string>, host: string): boolean {
  if (!set.size) return false;
  let h = host;
  for (;;) {
    if (set.has(h)) return true;
    const dot = h.indexOf('.');
    if (dot < 0) return false;
    h = h.slice(dot + 1);
  }
}

const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'or', 'ne', 'go', 'gob', 'mil', 'nic']);
/** Registrable-domain approximation (no PSL): last two labels, three for ccTLD second levels like co.uk. */
export function siteOf(host: string): string {
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const tld = parts[parts.length - 1];
  const sld = parts[parts.length - 2];
  const n = tld.length === 2 && SECOND_LEVEL.has(sld) ? 3 : 2;
  return parts.slice(-n).join('.');
}

export class Blocker {
  ready = false;
  rules = 0;
  enabled = true;
  private block = new Set<string>();
  private allow = new Set<string>();
  private disabledSites = new Set<string>();
  /** webContents id -> current top-level host, updated by the tab manager on navigation. */
  readonly topHost = new Map<number, string>();
  blockedCount = 0;
  onReady: (() => void) | null = null;

  async load(file: string) {
    try {
      const raw = JSON.parse(await fs.promises.readFile(file, 'utf8')) as { block: string[]; allow: string[] };
      this.block = new Set(raw.block);
      this.allow = new Set(raw.allow);
      this.rules = this.block.size + this.allow.size;
      this.ready = true;
      log(`ready: ${this.block.size} blocked domains, ${this.allow.size} never-block exceptions`);
      this.onReady?.();
    } catch (e) {
      log('could not load', path.basename(file), String(e));
    }
  }

  configure(enabled: boolean, disabledSites: string[]) {
    this.enabled = enabled;
    this.disabledSites = new Set(disabledSites);
  }

  shouldBlock(url: string, resourceType: string, webContentsId: number | undefined): boolean {
    if (!this.ready || !this.enabled || resourceType === 'mainFrame') return false;
    if (webContentsId === undefined) return false;
    const top = this.topHost.get(webContentsId);
    if (!top) return false;
    const host = hostOf(url);
    if (!host || host === top) return false;
    if (siteOf(host) === siteOf(top)) return false; // first-party: rules are third-party only
    if (inSet(this.disabledSites, top)) return false;
    if (!inSet(this.block, host)) return false;
    if (inSet(this.allow, host)) return false;
    return true;
  }

  attach(sess: Session) {
    sess.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (d, cb) => {
      const cancel = this.shouldBlock(d.url, d.resourceType, d.webContentsId);
      if (cancel) this.blockedCount++;
      cb({ cancel });
    });
  }
}
