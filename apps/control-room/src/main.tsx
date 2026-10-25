import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { router } from './router';
import { StoreProvider } from './data/store';
import { OpsProvider } from './live/ops';
import './styles/tokens.css';
import './styles/base.css';

// Colour theme: slate by default; ?theme=bahn shows the original palette, ?theme=slate comes back. Remembered.
const asked = new URLSearchParams(window.location.search).get('theme');
let theme = asked === 'bahn' ? 'bahn' : 'slate';
try {
  if (asked === 'slate' || asked === 'bahn') localStorage.setItem('cr-theme', asked);
  else if (localStorage.getItem('cr-theme') === 'bahn') theme = 'bahn';
} catch {
  // Storage can be blocked; the URL or the default decides.
}
if (theme === 'slate') document.documentElement.dataset.theme = 'slate';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StoreProvider>
      <OpsProvider>
        <RouterProvider router={router} />
      </OpsProvider>
    </StoreProvider>
  </StrictMode>,
);
