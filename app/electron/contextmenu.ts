// The right-click menu of a web page: a native menu built from what was clicked.
import { Menu, clipboard, type MenuItemConstructorOptions, type WebContents } from 'electron';
import { isAllowedTabUrl } from '../shared/state';

export interface MenuDeps {
  openTab(url: string, opts: { background?: boolean; pane?: 'secondary' }): void;
  /** Where "Search Google for" / "Ask Claude about" go (the same routes the address bar uses). */
  routeUrl(route: 'search' | 'claude', text: string): string;
  saveImage(wc: WebContents, url: string): void;
  viewSource(wc: WebContents): void;
}

/** The parts of Electron's ContextMenuParams the menu looks at (so tests can fake them). */
export type MenuParams = Pick<
  Electron.ContextMenuParams,
  'x' | 'y' | 'linkURL' | 'srcURL' | 'mediaType' | 'selectionText' | 'isEditable' | 'misspelledWord' | 'dictionarySuggestions' | 'editFlags'
>;

const clip = (s: string, n = 28) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export function menuTemplate(deps: MenuDeps, wc: WebContents, p: MenuParams): MenuItemConstructorOptions[] {
  const out: MenuItemConstructorOptions[] = [];
  const sep = () => {
    if (out.length && out[out.length - 1].type !== 'separator') out.push({ type: 'separator' });
  };
  const sel = (p.selectionText || '').trim();

  if (p.linkURL && isAllowedTabUrl(p.linkURL)) {
    out.push(
      { label: 'Open link in new tab', click: () => deps.openTab(p.linkURL, {}) },
      { label: 'Open in split pane', click: () => deps.openTab(p.linkURL, { pane: 'secondary' }) },
      { label: 'Copy link', click: () => clipboard.writeText(p.linkURL) }
    );
    sep();
  }

  if (p.mediaType === 'image' && p.srcURL) {
    const web = /^https?:/i.test(p.srcURL);
    if (web) out.push({ label: 'Open image in new tab', click: () => deps.openTab(p.srcURL, {}) });
    if (web) out.push({ label: 'Save image as…', click: () => deps.saveImage(wc, p.srcURL) });
    out.push({ label: 'Copy image', click: () => wc.copyImageAt(p.x, p.y) });
    sep();
  }

  if (p.isEditable) {
    if (p.misspelledWord) {
      for (const s of (p.dictionarySuggestions ?? []).slice(0, 5)) out.push({ label: s, click: () => wc.replaceMisspelling(s) });
      if (!p.dictionarySuggestions?.length) out.push({ label: 'No spelling suggestions', enabled: false });
      out.push({ label: 'Add to dictionary', click: () => wc.session.addWordToSpellCheckerDictionary(p.misspelledWord) });
      sep();
    }
    out.push(
      { label: 'Cut', enabled: p.editFlags.canCut, click: () => wc.cut() },
      { label: 'Copy', enabled: p.editFlags.canCopy, click: () => wc.copy() },
      { label: 'Paste', enabled: p.editFlags.canPaste, click: () => wc.paste() },
      { label: 'Select all', enabled: p.editFlags.canSelectAll, click: () => wc.selectAll() }
    );
    sep();
  } else if (sel) {
    out.push({ label: 'Copy', click: () => wc.copy() });
  }
  if (sel) {
    out.push(
      { label: `Search Google for “${clip(sel)}”`, click: () => deps.openTab(deps.routeUrl('search', sel), {}) },
      { label: `Ask Claude about “${clip(sel)}”`, click: () => deps.openTab(deps.routeUrl('claude', sel), {}) }
    );
    sep();
  }

  const h = wc.navigationHistory;
  out.push(
    { label: 'Back', enabled: h.canGoBack(), click: () => h.goBack() },
    { label: 'Forward', enabled: h.canGoForward(), click: () => h.goForward() },
    { label: 'Reload', click: () => wc.reload() },
    { type: 'separator' },
    { label: 'View page source', click: () => deps.viewSource(wc) },
    {
      label: 'Inspect',
      click: () => {
        if (!wc.isDevToolsOpened()) wc.openDevTools({ mode: 'detach' });
        wc.inspectElement(p.x, p.y);
      },
    }
  );
  return out;
}

export const buildPageMenu = (deps: MenuDeps, wc: WebContents, p: MenuParams) => Menu.buildFromTemplate(menuTemplate(deps, wc, p));
