import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { telemetryService } from './services/telemetryService';
import { jivvy, isElectron, isOverlayRole } from './platform';
import { bootstrapElectronStore } from './store/workspaceStore';

async function start() {
  if (isElectron) {
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
