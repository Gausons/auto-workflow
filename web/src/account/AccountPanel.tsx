import { useMutation } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { apiRequest, clearSessionToken } from '../api/client.js';

interface CurrentUser { username: string; displayName: string }
interface AccountPanelProps { reload?: () => void }

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

export function AccountPanel({ reload = () => location.reload() }: AccountPanelProps) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  useEffect(() => {
    const handleBootstrap = (event: Event) => {
      const value = (event as CustomEvent<{ user?: CurrentUser | null }>).detail?.user;
      setUser(value || null);
    };
    window.addEventListener('bugflow:bootstrap', handleBootstrap);
    const identity = (window as Window & { __bugflowIdentity?: { user?: CurrentUser | null } }).__bugflowIdentity;
    if (identity) setUser(identity.user || null);
    return () => window.removeEventListener('bugflow:bootstrap', handleBootstrap);
  }, []);

  const password = useMutation({
    mutationFn: (input: Record<string, FormDataEntryValue>) => apiRequest('/api/auth/password', {
      method: 'PUT', body: JSON.stringify(input)
    }),
    onSuccess: () => { clearSessionToken(); reload(); }
  });

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    password.mutate(Object.fromEntries(new FormData(event.currentTarget)));
  };

  return <div className="config-band">
    <h2>我的账号</h2>
    <p id="accountIdentity">{user ? `${user.username} · ${user.displayName}` : '正在读取账号信息…'}</p>
    <form id="passwordForm" className="fields-grid" onSubmit={submit}>
      <label>当前密码<input name="currentPassword" type="password" required autoComplete="current-password" maxLength={128} /></label>
      <label>新密码（12–128 位）<input name="password" type="password" required autoComplete="new-password" minLength={12} maxLength={128} /></label>
      <button className="button primary" type="submit" disabled={password.isPending}>{password.isPending ? '修改中…' : '修改密码并退出所有会话'}</button>
    </form>
    <p id="passwordStatus" role="status">{password.error ? messageOf(password.error) : ''}</p>
  </div>;
}
