import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useBrowserPreference } from './browserPreference.js';
import { defaultNewTaskPreference, parseNewTaskPreference } from '../tasks/newTaskPreference.js';

function preference(tenant = 'tenant-1', user = 'user-1', authenticated = true) {
  const client = new QueryClient();
  if (authenticated) client.setQueryData(['app', 'bootstrap'], { tenant: { id: tenant }, user: { id: user, username: user } });
  return renderHook(() => useBrowserPreference('new-task', defaultNewTaskPreference, parseNewTaskPreference), {
    wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  });
}

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

it('isolates remembered choices by both tenant and account across fresh clients', () => {
  const first = preference();
  act(() => first.result.current[1]({ ...defaultNewTaskPreference, projectId: 'p', deviceId: 'd', cwd: '/private/repo' }));
  first.unmount();
  expect(preference('tenant-2').result.current[0]).toEqual(defaultNewTaskPreference);
  expect(preference('tenant-1', 'user-2').result.current[0]).toEqual(defaultNewTaskPreference);
  expect(preference('tenant-1', 'user-1', false).result.current[0]).toEqual(defaultNewTaskPreference);
  expect(preference().result.current[0].cwd).toBe('/private/repo');
  expect(localStorage.length).toBe(1);
  expect(localStorage.key(0)).not.toContain('sessionToken');
});

it('ignores malformed saved data and validates each field', () => {
  const key = `bugflow.preference.${JSON.stringify(['tenant-1', 'user-1', 'new-task'])}`;
  localStorage.setItem(key, '{bad json');
  expect(preference().result.current[0]).toEqual(defaultNewTaskPreference);
  localStorage.setItem(key, JSON.stringify({ projectId: 1, deviceId: [], cwd: '/repo', model: 'a'.repeat(201), effort: null }));
  expect(preference().result.current[0]).toEqual({ ...defaultNewTaskPreference, cwd: '/repo' });
});

it('keeps changes usable when browser storage cannot be read or written', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage disabled'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage full'); });
  const current = preference();
  expect(current.result.current[0]).toEqual(defaultNewTaskPreference);
  act(() => current.result.current[1](previous => ({ ...previous, cwd: '/repo' })));
  expect(current.result.current[0].cwd).toBe('/repo');
});
