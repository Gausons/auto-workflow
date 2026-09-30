import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { apiRequest, saveSessionToken } from '../api/client.js';

const AUTH_REQUIRED_EVENT = 'bugflow:auth-required';

interface LoginResponse { token: string }
interface AuthScreenProps { hasSession: boolean; reload?: () => void }

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

export function AuthScreen({ hasSession, reload = () => location.reload() }: AuthScreenProps) {
  const params = new URLSearchParams(location.search);
  const [active, setActive] = useState(!hasSession);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [notice, setNotice] = useState(params.get('auth_error') || '');
  const googleHandled = useRef(false);
  const providers = useQuery({ queryKey: ['auth', 'providers'], queryFn: () => apiRequest<{ google: boolean }>('/api/auth/providers'), retry: false });
  const complete = ({ token }: LoginResponse) => { saveSessionToken(token); reload(); };
  const login = useMutation({
    mutationFn: (input: Record<string, FormDataEntryValue>) => apiRequest<LoginResponse>('/api/auth/login', {
      method: 'POST', body: JSON.stringify(input)
    }),
    onSuccess: complete
  });
  const register = useMutation({
    mutationFn: (input: Record<string, FormDataEntryValue>) => apiRequest<LoginResponse>('/api/auth/register', {
      method: 'POST', body: JSON.stringify(input)
    }),
    onSuccess: complete
  });
  const googleExchange = useMutation({
    mutationFn: (code: string) => apiRequest<LoginResponse>('/api/auth/google/exchange', {
      method: 'POST', body: JSON.stringify({ code })
    }),
    onSuccess: complete,
    onError: error => setNotice(messageOf(error))
  });

  useEffect(() => {
    const handleRequired = (event: Event) => {
      setActive(true);
      const detail = (event as CustomEvent<{ message?: string }>).detail;
      setNotice(detail?.message || '登录状态已失效，请重新登录');
    };
    window.addEventListener(AUTH_REQUIRED_EVENT, handleRequired);
    const pendingError = (window as Window & { __bugflowAuthError?: string }).__bugflowAuthError;
    if (pendingError) handleRequired(new CustomEvent(AUTH_REQUIRED_EVENT, { detail: { message: pendingError } }));
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, handleRequired);
  }, []);

  useEffect(() => {
    const code = new URLSearchParams(location.search).get('google_login');
    if (!code || googleHandled.current) return;
    googleHandled.current = true;
    history.replaceState(history.state, '', `${location.pathname}${location.hash}`);
    googleExchange.mutate(code);
  }, [googleExchange]);

  if (!active || googleExchange.isPending) return <div className="login-card"><p role="status">正在完成登录…</p></div>;
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setNotice('');
    const input = Object.fromEntries(new FormData(event.currentTarget));
    if (mode === 'login') login.mutate(input); else register.mutate(input);
  };
  const pending = login.isPending || register.isPending;
  const error = mode === 'login' ? login.error : register.error;

  return <div className="login-card">
    <p className="eyebrow">AgentFlow · 个人工作台</p>
    <h1>{mode === 'login' ? '登录' : '注册个人账号'}</h1>
    <p>{mode === 'login' ? '继续处理你的缺陷、任务和 Agent 会话。' : '每个账号拥有独立的数据和设置。'}</p>
    <a className="button google-button" href="/api/auth/google/start">使用 Google 单点登录</a>
    {providers.data?.google === false && <p className="google-status">Google 单点登录尚未配置</p>}
    {providers.isError && <p className="google-status">暂时无法检查 Google 单点登录配置</p>}
    <div className="auth-divider"><span>或</span></div>
    <form id={mode === 'login' ? 'loginForm' : 'registerForm'} onSubmit={submit}>
      <label htmlFor="authUsername">用户名{mode === 'register' ? '（推荐使用邮箱）' : ''}</label>
      <input id="authUsername" name="username" required minLength={3} maxLength={254} autoComplete="username" />
      {mode === 'register' && <><label htmlFor="authDisplayName">显示名称</label><input id="authDisplayName" name="displayName" required maxLength={80} autoComplete="name" /></>}
      <label htmlFor="authPassword">密码{mode === 'register' ? '（12–128 位）' : ''}</label>
      <input id="authPassword" name="password" type="password" required minLength={mode === 'register' ? 12 : undefined} maxLength={128} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
      <p className="login-error" role="alert">{error ? messageOf(error) : notice}</p>
      <button className="button primary" type="submit" disabled={pending}>{pending ? '请稍候…' : mode === 'login' ? '登录' : '注册并进入'}</button>
    </form>
    <button className="auth-switch" type="button" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setNotice(''); }}>
      {mode === 'login' ? '首次使用？注册个人账号' : '已有账号？返回登录'}
    </button>
  </div>;
}
