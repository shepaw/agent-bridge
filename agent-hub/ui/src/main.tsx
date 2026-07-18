import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { bootstrapHubAuthTokenFromUrl } from './api/client.js';
import { App } from './App.js';

bootstrapHubAuthTokenFromUrl();

const root = document.getElementById('root');
if (!root) throw new Error('No #root element');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
