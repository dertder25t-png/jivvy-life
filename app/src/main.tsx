import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { LAYOUT } from '../shared/layout';
import { telemetryService } from './services/telemetryService';
import { jivvy, isElectron, isOverlayRole, isEdgeRole } from './platform';
import { bootstrapElectronStore } from './store/workspaceStore';
import { installLagMonitor } from './lib/lagmon';

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
