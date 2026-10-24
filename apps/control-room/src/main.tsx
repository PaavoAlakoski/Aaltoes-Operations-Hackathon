import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { router } from './router';
import { StoreProvider } from './data/store';
import { OpsProvider } from './live/ops';
import './styles/tokens.css';
import './styles/base.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StoreProvider>
      <OpsProvider>
        <RouterProvider router={router} />
      </OpsProvider>
    </StoreProvider>
  </StrictMode>,
);
