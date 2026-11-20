import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { LAYOUT } from '../shared/layout';
import { telemetryService } from './services/telemetryService';
import { jivvy, isElectron, isOverlayRole, isEdgeRole } from './platform';
import { bootstrapElectronStore } from './store/workspaceStore';
import { installLagMonitor } from './lib/lagmon';
import { load, save } from './lib/dashboard/store';

/** After the one-time import from the old build: fold its dashboard keys into localStorage (once, no duplicates). */
async function adoptMigratedDashboard() {
  try {
    const d = await jivvy!.invoke<{ links?: unknown; notes?: unknown; recent?: unknown } | null>('take_migrated_dash');
    if (!d) return;
    const links = load<Array<{ name: string; url: string }>>('links', []);
    const addLinks = (Array.isArray(d.links) ? d.links : []).filter(
      (l): l is { name: string; url: string } => !!l && typeof l.name === 'string' && typeof l.url === 'string' && /^https?:\/\//i.test(l.url)
    );
    const have = new Set(links.map((l) => l.url.replace(/\/+$/, '').toLowerCase()));
    const merged = [...links, ...addLinks.filter((l) => !have.has(l.url.replace(/\/+$/, '').toLowerCase()))];
    if (merged.length !== links.length) save('links', merged);
    const recent = load<Array<{ id: string }>>('recent', []);
    const ids = new Set(recent.map((r) => r.id));
    const addRecent = (Array.isArray(d.recent) ? d.recent : []).filter((r): r is { id: string } => !!r && typeof r.id === 'string' && !ids.has(r.id));
    if (addRecent.length) save('recent', [...recent, ...addRecent].slice(0, 200));
    const notes = load<string>('notes', '');
    if (typeof d.notes === 'string' && d.notes.trim() && !notes.includes(d.notes.trim())) save('notes', notes ? `${notes}\n\n${d.notes}` : d.notes);
  } catch {
    /* not fatal: the dashboard just keeps what it has */
  }
}

async function start() {
  if (isEdgeRole) {
    // Invisible hover strip: no store, no chrome. Entering it asks main to float the address bar.
    document.documentElement.classList.add('overlay');
    const strip = document.getElementById('root')!;
    strip.style.cssText = 'position:fixed;inset:0;background:transparent';
    let t = 0;
    strip.addEventListener('mouseenter', () => {
      window.clearTimeout(t);
      t = window.setTimeout(() => jivvy!.emit({ type: 'edge-hover' }), LAYOUT.HOVER_OPEN_MS);
    });
    strip.addEventListener('mouseleave', () => window.clearTimeout(t));
    return;
  }
  if (isElectron) {
    installLagMonitor();
    document.documentElement.classList.add('electron');
    if (isOverlayRole) document.documentElement.classList.add('overlay');
    // Main -> UI events (e.g. Ctrl+L pressed inside a page) as window events for components.
    jivvy!.onEvent((ev) => window.dispatchEvent(new CustomEvent('jivvy:ui', { detail: ev })));
    await bootstrapElectronStore();
    if (!isOverlayRole) await adoptMigratedDashboard();
  }
  if (!isOverlayRole) telemetryService.start();
  const Root = isOverlayRole ? (await import('./overlay/OverlayApp')).default : App;
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <Root />
    </React.StrictMode>
  );
}

void start();
