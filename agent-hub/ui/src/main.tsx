import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { HubAuthGate } from './components/HubAuthGate.js';

const root = document.getElementById('root');
if (!root) throw new Error('No #root element');
createRoot(root).render(
  <StrictMode>
    <HubAuthGate>
      <App />
    </HubAuthGate>
  </StrictMode>,
);
