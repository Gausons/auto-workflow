import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { hasSessionToken } from './api/client.js';
import { AccountPanel } from './account/AccountPanel.js';
import { AuthScreen } from './auth/AuthScreen.js';
import { MembersPanel } from './members/MembersPanel.js';

const root = document.querySelector<HTMLElement>('#loginScreen');
if (!root) throw new Error('登录页面挂载点不存在');

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1 },
    mutations: { retry: false }
  }
});

createRoot(root).render(
  <QueryClientProvider client={queryClient}>
    <AuthScreen hasSession={hasSessionToken()} />
  </QueryClientProvider>
);

const accountRoot = document.querySelector<HTMLElement>('#reactAccountPanel');
if (accountRoot) createRoot(accountRoot).render(
  <QueryClientProvider client={queryClient}>
    <AccountPanel />
  </QueryClientProvider>
);

const membersRoot = document.querySelector<HTMLElement>('#reactMembersPanel');
if (membersRoot) createRoot(membersRoot).render(
  <QueryClientProvider client={queryClient}>
    <MembersPanel />
  </QueryClientProvider>
);
