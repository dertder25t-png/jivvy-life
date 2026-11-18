import JSZip from 'jszip';
import initSqlJs, { type Database } from 'sql.js';
import sqlWasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import { ImportedWorkspaceGroup, ImportResult, NoteDocument } from '../types/workspace';

export interface DomainVisits {
  domain: string;
  visits: number;
}

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;
const SQLITE_MAGIC = 'SQLite format 3\0';

/**
 * Parses a standard Firefox / Netscape bookmarks.html export into Workspace groups.
 * Top-level folders become selectable Workspaces with their links as tabs.
 */
export function parseFirefoxBookmarksHtml(htmlText: string): ImportedWorkspaceGroup[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlText, 'text/html');
  const groups: ImportedWorkspaceGroup[] = [];
  const rootTabs: Array<{ title: string; url: string }> = [];

  const folderHeaders = Array.from(doc.querySelectorAll('h3'));
  for (const h3 of folderHeaders) {
    const folderName = (h3.textContent || 'Imported Folder').trim();
    const dl = h3.nextElementSibling;
    if (!dl || dl.tagName.toLowerCase() !== 'dl') continue;

    const links = Array.from(dl.querySelectorAll(':scope > dt > a, :scope > p > dt > a'))
      .map((a) => ({
        title: (a.textContent || a.getAttribute('href') || 'Untitled').trim(),
        url: a.getAttribute('href') || '',
      }))
      .filter((item) => item.url.startsWith('http://') || item.url.startsWith('https://'));

    if (links.length > 0) {
      groups.push({ folderName, selected: true, tabs: links });
    }
  }

  // Fallback for loose bookmarks outside folders
  if (groups.length === 0) {
    const allLinks = Array.from(doc.querySelectorAll('a'))
      .map((a) => ({
        title: (a.textContent || a.getAttribute('href') || 'Untitled').trim(),
        url: a.getAttribute('href') || '',
      }))
      .filter((item) => item.url.startsWith('http://') || item.url.startsWith('https://'));
    rootTabs.push(...allLinks);
    if (rootTabs.length > 0) {
      groups.push({ folderName: 'Firefox Imports', selected: true, tabs: rootTabs });
    }
  }

  return groups;
}

// ---------------------------------------------------------------------------
// sql.js (Firefox places.sqlite)
// ---------------------------------------------------------------------------

let sqlPromise: ReturnType<typeof initSqlJs> | null = null;

function getSqlJs() {
  if (!sqlPromise) {
    sqlPromise = initSqlJs({ locateFile: () => sqlWasmUrl }).catch((err) => {
      sqlPromise = null; // allow a retry after a failed wasm load
      throw err;
    });
  }
  return sqlPromise;
}

type Row = Record<string, string | number | Uint8Array | null>;

function queryRows(db: Database, sql: string): Row[] {
  const [res] = db.exec(sql);
  if (!res) return [];
  return res.values.map((values) =>
    Object.fromEntries(res.columns.map((col, i) => [col, values[i]]))
  );
}

/** Firefox root folders have fixed GUIDs; map them to readable names. */
const FIREFOX_ROOT_GUIDS: Record<string, string> = {
  'menu________': 'Bookmarks Menu',
  'toolbar_____': 'Bookmarks Toolbar',
  'unfiled_____': 'Other Bookmarks',
  'mobile______': 'Mobile Bookmarks',
};
const FIREFOX_ROOT = 'root________';
const FIREFOX_TAGS = 'tags________';

function isHttpUrl(url: unknown): url is string {
  return typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'));
}

/**
 * Reads a Firefox places.sqlite file. Bookmarks become folder groups
 * (folder path joined with " / "), and topDomains is ranked by moz_places.visit_count.
 * Firefox may hold recent writes in places.sqlite-wal; close Firefox first for a complete read.
 */
export async function parseFirefoxPlacesSqlite(file: File): Promise<{
  workspaces: ImportedWorkspaceGroup[];
  topDomains: DomainVisits[];
}> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (new TextDecoder().decode(bytes.subarray(0, SQLITE_MAGIC.length)) !== SQLITE_MAGIC) {
    throw new Error('This file is not a SQLite database. Pick places.sqlite from your Firefox profile.');
  }

  const SQL = await getSqlJs();
  const db = new SQL.Database(bytes);
  try {
    let bookmarkRows: Row[];
    let placeRows: Row[];
    try {
      bookmarkRows = queryRows(
        db,
        `SELECT b.id, b.parent, b.type, b.guid, b.title, p.url
         FROM moz_bookmarks b LEFT JOIN moz_places p ON p.id = b.fk
         ORDER BY b.parent, b.position`
      );
      placeRows = queryRows(db, 'SELECT url, visit_count FROM moz_places WHERE visit_count > 0');
    } catch {
      throw new Error('places.sqlite is missing Firefox bookmark tables (moz_bookmarks / moz_places).');
    }

    // Index folders and children.
    const folders = new Map<number, { parent: number; guid: string; title: string | null }>();
    const childrenByParent = new Map<number, Row[]>();
    for (const row of bookmarkRows) {
      const id = Number(row.id);
      const parent = Number(row.parent);
      if (Number(row.type) === 2) {
        folders.set(id, {
          parent,
          guid: String(row.guid ?? ''),
          title: row.title == null ? null : String(row.title),
        });
      }
      const siblings = childrenByParent.get(parent) ?? [];
      siblings.push(row);
      childrenByParent.set(parent, siblings);
    }

    const isInTagsTree = (id: number): boolean => {
      let cur = folders.get(id);
      for (let depth = 0; cur && depth < 32; depth++) {
        if (cur.guid === FIREFOX_TAGS) return true;
        cur = folders.get(cur.parent);
      }
      return false;
    };
    const folderPath = (id: number): string => {
      const parts: string[] = [];
      let cur = folders.get(id);
      let curId = id;
      for (let depth = 0; cur && depth < 32; depth++) {
        if (cur.guid !== FIREFOX_ROOT) {
          parts.unshift(FIREFOX_ROOT_GUIDS[cur.guid] ?? cur.title ?? 'Untitled folder');
        }
        curId = cur.parent;
        cur = folders.get(curId);
      }
      return parts.join(' / ') || 'Firefox Bookmarks';
    };

    const workspaces: ImportedWorkspaceGroup[] = [];
    for (const [id, folder] of folders) {
      if (folder.guid === FIREFOX_ROOT || folder.guid === FIREFOX_TAGS || isInTagsTree(id)) continue;
      const tabs = (childrenByParent.get(id) ?? [])
        .filter((row) => Number(row.type) === 1 && isHttpUrl(row.url))
        .map((row) => ({ title: String(row.title || row.url).trim(), url: String(row.url) }));
      if (tabs.length > 0) {
        workspaces.push({ folderName: folderPath(id), selected: true, tabs });
      }
    }

    // Top domains from visit counts.
    const visitsByDomain = new Map<string, number>();
    for (const row of placeRows) {
      if (!isHttpUrl(row.url)) continue;
      let domain: string;
      try {
        domain = new URL(row.url).hostname.replace(/^www\./, '');
      } catch {
        continue;
      }
      visitsByDomain.set(domain, (visitsByDomain.get(domain) ?? 0) + Number(row.visit_count ?? 0));
    }
    const topDomains = Array.from(visitsByDomain, ([domain, visits]) => ({ domain, visits }))
      .sort((a, b) => b.visits - a.visits)
      .slice(0, 50);

    return { workspaces, topDomains };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Google Takeout (.zip / .json): Keep notes and Chrome bookmarks
// ---------------------------------------------------------------------------

function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

function usecToIso(usec: unknown): string {
  const ms = typeof usec === 'number' ? usec / 1000 : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date().toISOString();
}

interface KeepListItem {
  text?: string;
  isChecked?: boolean;
}

interface KeepNote {
  title?: string;
  textContent?: string;
  listContent?: KeepListItem[];
  labels?: Array<{ name?: string }>;
  isTrashed?: boolean;
  userEditedTimestampUsec?: number;
  createdTimestampUsec?: number;
}

function keepNoteToDocument(raw: KeepNote): NoteDocument | null {
  if (!raw || typeof raw !== 'object' || raw.isTrashed) return null;

  const body =
    raw.listContent && raw.listContent.length > 0
      ? raw.listContent.map((item) => `- [${item.isChecked ? 'x' : ' '}] ${item.text ?? ''}`).join('\n')
      : raw.textContent ?? '';

  const title =
    raw.title?.trim() || body.split('\n').find((line) => line.trim())?.trim().slice(0, 80) || 'Untitled Keep note';
  const content = raw.title?.trim() ? `# ${raw.title.trim()}\n\n${body}` : body;
  const wikilinks = Array.from(new Set(Array.from(content.matchAll(WIKILINK_RE), (m) => m[1].trim())));
  const tags = (raw.labels ?? []).map((l) => l.name?.trim() ?? '').filter(Boolean);

  return {
    id: randomId('note'),
    title,
    content,
    tags,
    wikilinks,
    updatedAt: usecToIso(raw.userEditedTimestampUsec ?? raw.createdTimestampUsec),
  };
}

function parseKeepNotes(json: unknown): NoteDocument[] {
  const list = Array.isArray(json) ? json : [json];
  return list
    .map((raw) => keepNoteToDocument(raw as KeepNote))
    .filter((note): note is NoteDocument => note !== null);
}

interface ChromeBookmarkNode {
  type?: string;
  name?: string;
  url?: string;
  children?: ChromeBookmarkNode[];
}

const CHROME_ROOT_NAMES: Record<string, string> = {
  bookmark_bar: 'Bookmarks Bar',
  other: 'Other Bookmarks',
  synced: 'Mobile Bookmarks',
};

function walkChromeFolder(node: ChromeBookmarkNode, path: string, out: ImportedWorkspaceGroup[]) {
  const children = node.children ?? [];
  const tabs = children
    .filter((c) => c.type === 'url' && isHttpUrl(c.url))
    .map((c) => ({ title: (c.name || c.url || 'Untitled').trim(), url: c.url as string }));
  if (tabs.length > 0) out.push({ folderName: path, selected: true, tabs });
  for (const child of children) {
    if (child.type === 'folder') {
      walkChromeFolder(child, `${path} / ${child.name || 'Untitled folder'}`, out);
    }
  }
}

/** Chrome's native `Bookmarks` JSON file: { roots: { bookmark_bar, other, synced } }. */
function parseChromeBookmarksJson(json: { roots: Record<string, unknown> }): ImportedWorkspaceGroup[] {
  const out: ImportedWorkspaceGroup[] = [];
  for (const [key, value] of Object.entries(json.roots)) {
    const root = value as ChromeBookmarkNode;
    if (!root || typeof root !== 'object' || root.type !== 'folder') continue;
    walkChromeFolder(root, CHROME_ROOT_NAMES[key] ?? root.name ?? key, out);
  }
  return out;
}

function isChromeBookmarksJson(json: unknown): json is { roots: Record<string, unknown> } {
  return !!json && typeof json === 'object' && !Array.isArray(json) && 'roots' in json;
}

/**
 * Reads a Google Takeout .zip (Keep/*.json notes, Chrome/Bookmarks files) or a single .json
 * (a Keep note, a list of notes, or a Chrome Bookmarks file).
 */
export async function parseGoogleTakeout(file: File): Promise<{
  workspaces: ImportedWorkspaceGroup[];
  notes: NoteDocument[];
}> {
  const workspaces: ImportedWorkspaceGroup[] = [];
  const notes: NoteDocument[] = [];

  if (/\.zip$/i.test(file.name)) {
    const zip = await JSZip.loadAsync(file);
    for (const entry of Object.values(zip.files)) {
      if (entry.dir) continue;
      const path = entry.name.toLowerCase();
      try {
        if (path.includes('keep/') && path.endsWith('.json')) {
          notes.push(...parseKeepNotes(JSON.parse(await entry.async('string'))));
        } else if (path.includes('chrome/') && /bookmarks(\.json|\.html?)?$/.test(path)) {
          if (/\.html?$/.test(path)) {
            workspaces.push(...parseFirefoxBookmarksHtml(await entry.async('string')));
          } else {
            const json = JSON.parse(await entry.async('string'));
            if (isChromeBookmarksJson(json)) workspaces.push(...parseChromeBookmarksJson(json));
          }
        }
      } catch {
        // Skip malformed entries rather than failing the whole archive.
      }
    }
  } else {
    let json: unknown;
    try {
      json = JSON.parse(await file.text());
    } catch {
      throw new Error(`"${file.name}" is not valid JSON.`);
    }
    if (isChromeBookmarksJson(json)) {
      workspaces.push(...parseChromeBookmarksJson(json));
    } else {
      notes.push(...parseKeepNotes(json));
    }
  }

  return { workspaces, notes };
}

// ---------------------------------------------------------------------------
// Dispatcher used by the ImportWizard
// ---------------------------------------------------------------------------

/** Parses any supported import file into an ImportResult (groups are selected by default). */
export async function parseImportFile(file: File): Promise<ImportResult> {
  const name = file.name.toLowerCase();
  let result: ImportResult;

  if (name.endsWith('.html') || name.endsWith('.htm')) {
    result = { workspaces: parseFirefoxBookmarksHtml(await file.text()), notes: [], topDomains: [] };
  } else if (name.endsWith('.sqlite') || name.endsWith('.sqlite3')) {
    const places = await parseFirefoxPlacesSqlite(file);
    result = { workspaces: places.workspaces, notes: [], topDomains: places.topDomains };
  } else if (name.endsWith('.zip') || name.endsWith('.json')) {
    const takeout = await parseGoogleTakeout(file);
    result = { workspaces: takeout.workspaces, notes: takeout.notes, topDomains: [] };
  } else {
    throw new Error(`Unsupported file "${file.name}". Use bookmarks.html, places.sqlite, or a Google Takeout .zip/.json.`);
  }

  if (result.workspaces.length === 0 && result.notes.length === 0) {
    throw new Error(`No bookmarks or notes were found in "${file.name}".`);
  }
  return result;
}
