import { useQueryClient } from '@tanstack/react-query';
import { useState, type SetStateAction } from 'react';

interface PreferenceIdentity { tenant?: { id: string }; user?: { id?: string; username: string } }

export const preferenceRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

// AppRoot loads this identity before mounting account pages. Never use a shared
// fallback key while identity is unavailable, or store the session token.
export function useBrowserPreference<T>(name: string, fallback: T, parse: (value: unknown) => T) {
  const client = useQueryClient();
  const identity = client.getQueryData<PreferenceIdentity>(['app', 'bootstrap']);
  const userId = identity?.user?.id || identity?.user?.username;
  const key = identity?.tenant?.id && userId
    ? `bugflow.preference.${JSON.stringify([identity.tenant.id, userId, name])}` : null;
  const [value, setValue] = useState<T>(() => {
    try { return key ? parse(JSON.parse(localStorage.getItem(key) || 'null')) : fallback; }
    catch { return fallback; }
  });
  function update(next: SetStateAction<T>) {
    setValue(previous => {
      const result = typeof next === 'function' ? (next as (previous: T) => T)(previous) : next;
      try { if (key) localStorage.setItem(key, JSON.stringify(result)); }
      catch { /* Browser storage is optional; keep the current page usable. */ }
      return result;
    });
  }
  return [value, update] as const;
}
