import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { apiRequest, hasSessionToken } from '../api/client.js';

interface Person { name: string; employeeId: string; responsibility: string }
interface Config {
  assignee?: string; operatorId?: string; codexWorkspaceDir?: string; intervalMinutes?: number;
  selfOnly?: boolean; enableAIAssignment?: boolean; enableAutoAssignment?: boolean;
  aiAssignmentModel?: string; openaiBaseUrl?: string; openaiTimeoutMs?: number;
  workspaceManaged?: boolean; issueSourceConfigured?: boolean; issueSourceLabel?: string;
}
interface SettingsBootstrap {
  config: Config;
  scheduler: { enabled?: boolean };
  assignmentPeople: Person[];
  permissions: string[];
}

const settingsKey = ['settings', 'bootstrap'] as const;
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const modelIds = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'];

function useSettings(section: 'config' | 'assignment') {
  const isActive = () => location.hash === `#settings/${section}` || location.hash === `#${section}` || (section === 'assignment' && location.hash === '#settings');
  const [active, setActive] = useState(isActive);
  useEffect(() => {
    const update = () => setActive(isActive());
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, [section]);
  return useQuery({
    queryKey: settingsKey,
    queryFn: ({ signal }) => apiRequest<SettingsBootstrap>('/api/bootstrap', { signal }),
    enabled: active && hasSessionToken(),
    refetchOnWindowFocus: false
  });
}

function publish(client: ReturnType<typeof useQueryClient>, data: SettingsBootstrap) {
  client.setQueryData(settingsKey, data);
  window.dispatchEvent(new CustomEvent('bugflow:settings-updated', { detail: data }));
}

export function ConfigPanel() {
  const client = useQueryClient();
  const query = useSettings('config');
  const [status, setStatus] = useState('');
  const [formVersion, setFormVersion] = useState(0);
  const canManage = query.data?.permissions.includes('config.manage') === true;
  const save = useMutation({
    retry: false,
    mutationFn: (payload: Record<string, FormDataEntryValue | number | boolean>) => apiRequest<SettingsBootstrap>('/api/config', { method: 'PUT', body: JSON.stringify(payload) }),
    onSuccess: data => { publish(client, data); setFormVersion(value => value + 1); setStatus('配置已保存'); },
    onError: error => setStatus(errorMessage(error))
  });
  const scheduler = useMutation({
    retry: false,
    mutationFn: (enabled: boolean) => apiRequest<SettingsBootstrap>('/api/scheduler', { method: 'POST', body: JSON.stringify({ enabled }) }),
    onSuccess: data => { publish(client, data); setStatus(data.scheduler.enabled ? '定时同步已开启' : '定时同步已关闭'); },
    onError: error => setStatus(errorMessage(error))
  });
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const payload: Record<string, FormDataEntryValue | number | boolean> = Object.fromEntries(form.entries());
    payload.intervalMinutes = Number(payload.intervalMinutes);
    payload.openaiTimeoutMs = Number(payload.openaiTimeoutMs);
    payload.selfOnly = form.has('selfOnly');
    payload.enableAIAssignment = form.has('enableAIAssignment');
    payload.enableAutoAssignment = form.has('enableAutoAssignment');
    setStatus(''); save.mutate(payload);
  };

  if (query.isPending) return <div className="config-band" role="status">正在读取配置…</div>;
  if (query.isError) return <div className="config-band" role="alert">{errorMessage(query.error)} <button type="button" onClick={() => query.refetch()}>重试</button></div>;
  if (!canManage) return <div className="config-band">当前账号没有配置权限。</div>;
  const config = query.data.config;
  const busy = save.isPending || scheduler.isPending;
  return <div className="config-band" id="config">
    <form key={formVersion} className="config-form" id="configForm" onSubmit={submit}>
      <div className="form-heading"><div><h2>对接配置</h2><p>默认数据源为 Jira Cloud。地址、JQL 和凭据在组织环境文件中配置，修改后重启。</p></div></div>
      <div className="fields-grid">
        <label><span>扩展数据源经办人</span><div className="combo-field">
          <input name="assignee" id="configAssignee" defaultValue={config.assignee || ''} autoComplete="off" placeholder="人员 ID（Jira 请通过 JQL 筛选）" />
          <select aria-label="选择经办人" defaultValue="" onChange={event => { const input = document.querySelector<HTMLInputElement>('#configAssignee'); if (input && event.target.value) input.value = event.target.value; }}>
            <option value="">选择员工</option>{query.data.assignmentPeople.map(person => <option key={person.employeeId} value={person.employeeId}>{person.name}</option>)}
          </select></div></label>
        <label><span>扩展数据源操作人</span><input name="operatorId" defaultValue={config.operatorId || ''} autoComplete="off" placeholder="流程流转时使用" /></label>
        <label><span>IDE 执行路径</span><input name="codexWorkspaceDir" defaultValue={config.codexWorkspaceDir || ''} autoComplete="off" placeholder="/srv/bugflow/repos/my-project" />
          {config.workspaceManaged && <small>工作目录由团队管理员配置；需要调整时请联系管理员。</small>}</label>
        <label><span>轮询间隔（分钟）</span><input name="intervalMinutes" type="number" min="1" max="240" defaultValue={config.intervalMinutes ?? 1} /></label>
        <label className="checkbox-field"><input name="selfOnly" type="checkbox" value="true" defaultChecked={Boolean(config.selfOnly)} /><span>只看当前个人 Token 数据</span></label>
        <label className="checkbox-field"><input name="enableAIAssignment" type="checkbox" value="true" defaultChecked={Boolean(config.enableAIAssignment)} /><span>开启 AI 分配建议</span></label>
        <label className="checkbox-field"><input name="enableAutoAssignment" type="checkbox" value="true" defaultChecked={Boolean(config.enableAutoAssignment)} /><span>开启自动分配</span></label>
        <label><span>AI 分配模型</span><select name="aiAssignmentModel" defaultValue={config.aiAssignmentModel || 'gpt-5.4-mini'}>{modelIds.map(id => <option key={id} value={id}>{id.replace(/^gpt-/, 'GPT-').replace(/-([a-z])/g, (_, letter: string) => ` ${letter.toUpperCase()}`)}</option>)}</select></label>
        <label><span>OpenAI Base URL</span><input name="openaiBaseUrl" defaultValue={config.openaiBaseUrl || ''} autoComplete="off" placeholder="https://api.openai.com/v1" /></label>
        <label><span>OpenAI 请求超时（ms）</span><input name="openaiTimeoutMs" type="number" min="5000" max="120000" defaultValue={config.openaiTimeoutMs ?? 30000} /></label>
      </div>
      <div className="form-actions"><div className="credential-state">{config.issueSourceConfigured ? `${config.issueSourceLabel} 已配置` : `${config.issueSourceLabel || '数据源'} 未配置`}</div>
        <button className="button secondary" type="button" disabled={busy} onClick={() => scheduler.mutate(!query.data.scheduler.enabled)}>{query.data.scheduler.enabled ? '关闭定时' : '开启定时'}</button>
        <button className="button primary" type="submit" disabled={busy}>保存配置</button>
      </div>
    </form>
    <p role="status" aria-live="polite">{status}</p>
  </div>;
}

export function AssignmentPanel() {
  const client = useQueryClient();
  const query = useSettings('assignment');
  const [status, setStatus] = useState('');
  const canManage = query.data?.permissions.includes('people.manage') === true;
  const save = useMutation({
    retry: false,
    mutationFn: (people: Person[]) => apiRequest<SettingsBootstrap>('/api/assignment/people', { method: 'PUT', body: JSON.stringify({ people }) }),
    onSuccess: data => { publish(client, data); setStatus('分配规则已保存'); },
    onError: error => setStatus(errorMessage(error))
  });
  if (query.isPending) return <section className="config-band" role="status">正在读取分配规则…</section>;
  if (query.isError) return <section className="config-band" role="alert">{errorMessage(query.error)} <button type="button" onClick={() => query.refetch()}>重试</button></section>;
  const people = query.data.assignmentPeople;
  const add = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = event.currentTarget; const values = new FormData(form);
    const person: Person = { name: String(values.get('name') || '').trim(), employeeId: String(values.get('employeeId') || '').trim(), responsibility: String(values.get('responsibility') || '').trim() };
    save.mutate([...people.filter(item => item.employeeId !== person.employeeId), person], { onSuccess: () => form.reset() });
  };
  const edit = (event: React.FormEvent<HTMLFormElement>, oldId: string) => {
    event.preventDefault(); const values = new FormData(event.currentTarget);
    const person: Person = { name: String(values.get('name') || '').trim(), employeeId: String(values.get('employeeId') || '').trim(), responsibility: String(values.get('responsibility') || '').trim() };
    save.mutate([...people.filter(item => item.employeeId !== oldId && item.employeeId !== person.employeeId), person]);
  };
  return <>
    <section className="config-band"><div className="panel-title"><div><h2>分配规则</h2><p className="panel-subtitle">维护 AI 分配建议可选人员和职责，保存后用于下一次推荐。</p></div><span>{people.length} 人</span></div>
      {canManage && <form className="config-form" onSubmit={add}><div className="fields-grid assignment-add-grid">
        <label><span>姓名</span><input name="name" autoComplete="off" required /></label>
        <label><span>员工号</span><input name="employeeId" autoComplete="off" required /></label>
        <label className="wide-field"><span>职责</span><textarea name="responsibility" rows={3} required /></label>
      </div><div className="form-actions"><button className="button primary" type="submit" disabled={save.isPending}>添加人员</button></div></form>}
      <p role="status" aria-live="polite">{status}</p>
    </section>
    <section className="task-band"><div className="panel-title"><h2>人员职责</h2><span>编辑后逐条保存</span></div>
      <div className="assignment-people-list">{people.length ? people.map(person => <form className="member-card" key={person.employeeId} onSubmit={event => edit(event, person.employeeId)}>
        <label>姓名<input name="name" defaultValue={person.name} disabled={!canManage} required /></label>
        <label>员工号<input name="employeeId" defaultValue={person.employeeId} disabled={!canManage} required /></label>
        <label>职责<textarea name="responsibility" defaultValue={person.responsibility} disabled={!canManage} required /></label>
        {canManage && <><button className="button secondary" type="submit" disabled={save.isPending}>保存</button>
          <button className="button ghost" type="button" disabled={save.isPending} onClick={() => save.mutate(people.filter(item => item.employeeId !== person.employeeId))}>删除</button></>}
      </form>) : <div className="empty">尚未配置人员。</div>}</div>
    </section>
  </>;
}
