import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { HubAuthGate } from './components/HubAuthGate.js';
import { I18nProvider } from './i18n/index.js';

const root = document.getElementById('root');
if (!root) throw new Error('No #root element');
createRoot(root).render(
  <StrictMode>
    <I18nProvider>
      <HubAuthGate>
        <App />
      </HubAuthGate>
    </I18nProvider>
  </StrictMode>,
);
