// Tracks which UI surfaces (menus, dialogs) overlap the native webview so it can hide while any is open.
const open = new Set<string>();
export function setOverlay(source: string, isOpen: boolean) {
  const had = open.size > 0;
  if (isOpen) open.add(source);
  else open.delete(source);
  window.dispatchEvent(new CustomEvent('lifeapp:overlay', { detail: { source, open: open.size > 0 } }));
  void had;
}
