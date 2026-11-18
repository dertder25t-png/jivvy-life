import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { telemetryService } from './services/telemetryService';

telemetryService.start();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
