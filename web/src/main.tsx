import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { hasSessionToken } from './api/client.js';
import { AccountPanel } from './account/AccountPanel.js';
import { AuthScreen } from './auth/AuthScreen.js';
import { MembersPanel } from './members/MembersPanel.js';
import { HistoryPage } from './history/HistoryPage.js';
import { WorkbenchPage } from './workbench/WorkbenchPage.js';
import { AssignmentPanel, ConfigPanel } from './settings/SettingsPanels.js';

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

const workbenchRoot = document.querySelector<HTMLElement>('#reactWorkbenchPage');
if (workbenchRoot) createRoot(workbenchRoot).render(
  <QueryClientProvider client={queryClient}>
    <WorkbenchPage />
  </QueryClientProvider>
);

const configRoot = document.querySelector<HTMLElement>('#reactConfigPanel');
if (configRoot) createRoot(configRoot).render(
  <QueryClientProvider client={queryClient}>
    <ConfigPanel />
  </QueryClientProvider>
);

const assignmentRoot = document.querySelector<HTMLElement>('#reactAssignmentPanel');
if (assignmentRoot) createRoot(assignmentRoot).render(
  <QueryClientProvider client={queryClient}>
    <AssignmentPanel />
  </QueryClientProvider>
);

const historyRoot = document.querySelector<HTMLElement>('#reactHistoryPage');
if (historyRoot) createRoot(historyRoot).render(
  <QueryClientProvider client={queryClient}>
    <HistoryPage />
  </QueryClientProvider>
);
