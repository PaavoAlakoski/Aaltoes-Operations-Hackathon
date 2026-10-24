import { createBrowserRouter } from 'react-router';
import { Shell } from './ui/Shell';
import { NeedsYou } from './pages/NeedsYou';
import { OrderPage } from './pages/OrderPage';
import { AllOrders } from './pages/AllOrders';
import { Inbox } from './pages/Inbox';
import { Agents } from './pages/Agents';
import { NotFound, Crashed } from './pages/NotFound';
import { LivePage } from './live/LivePage';

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
      { path: '/live', element: <LivePage /> },
      { path: '*', element: <NotFound /> },
    ],
  },
]);
