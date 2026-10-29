import { useState } from 'react';
import { Link } from 'react-router';
import { DismissibleDetails } from '../components/DismissibleDetails.js';
import { enterWorkspace, useWorkspaces } from './workspaceApi.js';
import styles from './Workspace.module.css';

export function WorkspaceSwitcher() {
  const query = useWorkspaces();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const current = query.data?.workspaces.find(item => item.id === query.data.currentId);
  async function change(id: string) {
    setPending(true); setError('');
    try { await enterWorkspace(id); } catch (caught) { setError(caught instanceof Error ? caught.message : '切换失败'); setPending(false); }
  }
  return <div className={styles.switcher}><DismissibleDetails><summary aria-label="切换协作空间"><span className={styles.spaceIcon} aria-hidden="true">{current?.kind === 'team' ? '◈' : '○'}</span><span><strong>{current?.kind === 'personal' ? '个人空间' : current?.name || '工作空间'}</strong><small>{query.isPending ? '正在加载…' : current?.kind === 'team' ? '团队协作' : '当前账号'}</small></span><span aria-hidden="true">⌄</span></summary><div className={styles.switcherMenu}><span className={styles.eyebrow}>切换空间</span>{query.data?.workspaces.map(item => <button key={item.id} type="button" disabled={pending || item.id === current?.id} onClick={() => void change(item.id)}><span>{item.kind === 'personal' ? '个人空间' : item.name}</span>{item.id === current?.id && <span aria-label="当前空间">✓</span>}</button>)}<Link to="/space">管理空间{query.data?.invitations.length ? ` · ${query.data.invitations.length} 个邀请` : ''}<span>↗</span></Link></div></DismissibleDetails>{(error || query.isError) && <p role="alert">{error || '空间加载失败，请刷新重试'}</p>}</div>;
}
