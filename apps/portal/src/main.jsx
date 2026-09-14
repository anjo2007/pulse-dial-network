import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import './styles.css';

const container = document.getElementById('root');

if (!container) {
  // Nothing to render into - fail loudly rather than silently rendering a blank page.
  throw new Error('Pulse Dial portal could not start: #root container is missing from index.html.');
}

createRoot(container).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
