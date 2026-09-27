import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { App } from './app/App.js';

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('Web 应用挂载点不存在');

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1 }, mutations: { retry: false } }
});

createRoot(root).render(<QueryClientProvider client={queryClient}><App /></QueryClientProvider>);
