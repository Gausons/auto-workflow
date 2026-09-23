import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { apiRequest, saveSessionToken } from '../api/client.js';

const AUTH_REQUIRED_EVENT = 'bugflow:auth-required';

interface LoginResponse { token: string }
interface SetupResponse { tenant: { id: string }; message: string }
interface AuthScreenProps {
  hasSession: boolean;
  reload?: () => void;
}

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

export function AuthScreen({ hasSession, reload = () => location.reload() }: AuthScreenProps) {
  const [active, setActive] = useState(!hasSession);
  const [notice, setNotice] = useState('');
  const [tenantId, setTenantId] = useState('default');
  const [username, setUsername] = useState('');
  const setupDetails = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const handleRequired = (event: Event) => {
      setActive(true);
      const detail = (event as CustomEvent<{ message?: string }>).detail;
      setNotice(detail?.message || '登录状态已失效，请重新登录');
    };
    window.addEventListener(AUTH_REQUIRED_EVENT, handleRequired);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, handleRequired);
  }, []);

  const login = useMutation({
    mutationFn: (input: Record<string, FormDataEntryValue>) => apiRequest<LoginResponse>('/api/auth/login', {
      method: 'POST', body: JSON.stringify(input)
    }),
    onSuccess: ({ token }) => { saveSessionToken(token); reload(); }
  });
  const setup = useMutation({
    mutationFn: ({ token, input }: { token: string; input: Record<string, FormDataEntryValue> }) => apiRequest<SetupResponse>('/api/auth/setup', {
      method: 'POST', body: JSON.stringify(input)
    }, token.trim()),
    onSuccess: (data, variables) => {
      setTenantId(data.tenant.id);
      setUsername(String(variables.input.username || ''));
      setNotice(data.message);
      if (setupDetails.current) setupDetails.current.open = false;
    }
  });

  if (!active) return <div className="login-card"><p role="status">正在加载工作台…</p></div>;

  const submitLogin = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setNotice('');
    login.mutate(Object.fromEntries(new FormData(event.currentTarget)));
  };
  const submitSetup = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const { token, ...input } = Object.fromEntries(new FormData(form));
    setup.mutate({ token: String(token || ''), input }, { onSuccess: () => form.reset() });
  };

  return <div className="login-card">
    <p className="eyebrow">BugFlow · 组织工作台</p>
    <h1>登录你的组织</h1>
    <form id="loginForm" onSubmit={submitLogin}>
      <label htmlFor="loginOrganization">组织 ID</label>
      <input id="loginOrganization" name="tenantId" value={tenantId} onChange={event => setTenantId(event.target.value)} required autoComplete="organization" />
      <label htmlFor="loginUsername">用户名</label>
      <input id="loginUsername" name="username" value={username} onChange={event => setUsername(event.target.value)} required autoComplete="username" />
      <label htmlFor="loginPassword">密码</label>
      <input id="loginPassword" name="password" type="password" required autoComplete="current-password" maxLength={128} />
      <p id="loginError" className="login-error" role="alert">{login.error ? messageOf(login.error) : notice}</p>
      <button className="button primary" type="submit" disabled={login.isPending}>{login.isPending ? '登录中…' : '登录'}</button>
    </form>
    <details className="setup-details" id="setupDetails" ref={setupDetails}>
      <summary>首次使用？初始化组织所有者</summary>
      <p>使用原组织令牌创建首位所有者。初始化后，所有成员均使用个人账号登录。</p>
      <form id="setupForm" onSubmit={submitSetup}>
        <label>组织初始化令牌<input name="token" type="password" required autoComplete="off" /></label>
        <label>所有者用户名<input name="username" required minLength={3} maxLength={80} autoComplete="username" /></label>
        <label>显示名称<input name="displayName" required maxLength={80} autoComplete="name" /></label>
        <label>密码（12–128 位）<input name="password" type="password" required minLength={12} maxLength={128} autoComplete="new-password" /></label>
        <p id="setupError" className="login-error" role="alert">{setup.error ? messageOf(setup.error) : ''}</p>
        <button className="button primary" type="submit" disabled={setup.isPending}>{setup.isPending ? '创建中…' : '创建组织所有者'}</button>
      </form>
    </details>
  </div>;
}
