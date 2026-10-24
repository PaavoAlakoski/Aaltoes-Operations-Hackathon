import { Navigate, createBrowserRouter } from 'react-router';
import { Shell } from './ui/Shell';
import { NeedsYou } from './pages/NeedsYou';
import { OrderPage } from './pages/OrderPage';
import { AllOrders } from './pages/AllOrders';
import { Inbox } from './pages/Inbox';
import { Agents } from './pages/Agents';
import { NotFound, Crashed } from './pages/NotFound';

export const router = createBrowserRouter([
  {
    element: <Shell />,
    errorElement: <Crashed />,
    children: [
      { path: '/', element: <NeedsYou /> },
      { path: '/orders', element: <AllOrders /> },
      { path: '/orders/:ref', element: <OrderPage /> },
      { path: '/inbox', element: <Inbox /> },
      { path: '/agents', element: <Agents /> },
      // Live operations now sit inside Needs you and each order; old links still land.
      { path: '/live', element: <Navigate to="/" replace /> },
      { path: '*', element: <NotFound /> },
    ],
  },
]);
