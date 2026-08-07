import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// Fonts are bundled rather than fetched: the app must work offline and the CSP blocks
// every remote origin.
import '@fontsource/fira-sans/400.css';
import '@fontsource/fira-sans/500.css';
import '@fontsource/fira-sans/600.css';
import '@fontsource/fira-code/400.css';
import '@fontsource/fira-code/600.css';

import './styles/tokens.css';
import './styles/app.css';
import { App } from './App';

const container = document.getElementById('root');
if (container === null) throw new Error('root element is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
