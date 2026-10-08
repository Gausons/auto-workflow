import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { apiRequest, saveSessionToken } from '../api/client.js';
import styles from './AuthScreen.module.css';

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

  return <main className={styles.panel}>
    <header className={styles.header}>
      <svg className={styles.mark} viewBox="0 0 48 48" fill="none" aria-hidden="true"><rect width="48" height="48" rx="14" fill="currentColor" /><g stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="10" y="11" width="28" height="26" rx="6" /><path d="M17 20h14M17 27h7M30 26l4 4-4 4" /></g></svg>
      <h1>{mode === 'login' ? '登录 AgentFlow' : '注册个人账号'}</h1>
      <p>{mode === 'login' ? '你的缺陷、任务与 Agent 会话，尽在一处。' : '创建账号，开启你的个人工作台。'}</p>
    </header>
    <form id={mode === 'login' ? 'loginForm' : 'registerForm'} onSubmit={submit}>
      <label htmlFor="authUsername">用户名{mode === 'register' ? '（推荐使用邮箱）' : ''}</label>
      <input id="authUsername" name="username" required minLength={3} maxLength={254} autoComplete="username" autoCapitalize="none" spellCheck={false} />
      {mode === 'register' && <><label htmlFor="authDisplayName">显示名称</label><input id="authDisplayName" name="displayName" required maxLength={80} autoComplete="name" /></>}
      <label htmlFor="authPassword">密码{mode === 'register' ? '（12–128 位）' : ''}</label>
      <input id="authPassword" name="password" type="password" required minLength={mode === 'register' ? 12 : undefined} maxLength={128} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
      {(error || notice) && <p className={styles.error} role="alert">{error ? messageOf(error) : notice}</p>}
      <button className={styles.submit} type="submit" disabled={pending}>{pending ? '请稍候…' : mode === 'login' ? '登录' : '注册并进入'}</button>
    </form>
    <div className={styles.divider}><span>或</span></div>
    <a className={styles.google} href="/api/auth/google/start"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-2 3.02v2.51h3.24c1.9-1.75 2.98-4.33 2.98-7.36Z" /><path fill="#34A853" d="M12 22c2.7 0 4.96-.9 6.62-2.41l-3.24-2.51c-.9.6-2.05.96-3.38.96-2.61 0-4.82-1.76-5.61-4.12H3.04v2.59A10 10 0 0 0 12 22Z" /><path fill="#FBBC05" d="M6.39 13.92a6 6 0 0 1 0-3.84V7.49H3.04a10 10 0 0 0 0 9.02l3.35-2.59Z" /><path fill="#EA4335" d="M12 5.96c1.47 0 2.79.51 3.83 1.51l2.87-2.87A9.62 9.62 0 0 0 12 2a10 10 0 0 0-8.96 5.49l3.35 2.59C7.18 7.72 9.39 5.96 12 5.96Z" /></svg>使用 Google 单点登录</a>
    {providers.data?.google === false && <p className={styles.providerStatus}>Google 单点登录尚未配置</p>}
    {providers.isError && <p className={styles.providerStatus}>暂时无法检查 Google 单点登录配置</p>}
    <button className={styles.switchMode} type="button" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setNotice(''); }}>
      {mode === 'login' ? '首次使用？注册个人账号' : '已有账号？返回登录'}
    </button>
    <footer className={styles.footer}>AgentFlow · 个人研发工作台</footer>
  </main>;
}
