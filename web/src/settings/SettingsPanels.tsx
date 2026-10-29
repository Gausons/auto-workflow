import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { apiRequest, hasSessionToken } from '../api/client.js';
import { AI_ASSIGNMENT_MODELS } from '../../../shared/assignmentModels.js';
import styles from './SettingsPanels.module.css';

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

function useSettings(section: 'config' | 'assignment') {
  const isActive = () => location.pathname === `/settings/${section}` || location.hash === `#settings/${section}` || location.hash === `#${section}` || (section === 'assignment' && (location.pathname === '/settings' || location.hash === '#settings'));
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
    for (const key of ['intervalMinutes', 'openaiTimeoutMs']) {
      if (payload[key] === '') delete payload[key];
      else payload[key] = Number(payload[key]);
    }
    if (!payload.aiAssignmentModel) delete payload.aiAssignmentModel;
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
  const selectedModel = config.aiAssignmentModel || '';
  const savedAssignee = config.assignee || '';
  const unlistedAssignee = savedAssignee && !query.data.assignmentPeople.some(person => person.employeeId === savedAssignee);
  const legacyModel = AI_ASSIGNMENT_MODELS.some(model => model.id === selectedModel) ? '' : selectedModel;
  return <div className={`config-band ${styles.panel}`} id="config">
    <form key={formVersion} className={styles.form} id="configForm" onSubmit={submit}>
      <header className={styles.heading}>
        <div><h2>对接配置</h2><p>管理数据源同步与智能分配。</p></div>
        <span className={styles.sourceState} data-configured={Boolean(config.issueSourceConfigured)}>
          <i aria-hidden="true" />{config.issueSourceLabel || '数据源'}{config.issueSourceConfigured ? ' 已配置' : ' 未配置'}
        </span>
      </header>
      <section className={styles.section} aria-labelledby="sourceHeading">
        <div className={styles.sectionHeading}><h3 id="sourceHeading">数据源</h3><p>设置扩展数据源的人员范围。</p></div>
        <div className={styles.fields}>
          <p className={styles.hint}>Jira 地址、JQL 和凭据在服务端环境文件中配置，修改后重启。Jira 经办人请通过 JQL 筛选。</p>
          <label htmlFor="configAssignee"><span id="assigneeLabel">扩展数据源经办人</span>
            <select name="assignee" id="configAssignee" aria-labelledby="assigneeLabel" defaultValue={savedAssignee} aria-describedby="assigneeHelp">
              <option value="">不指定经办人</option>
              {unlistedAssignee && <option value={savedAssignee}>当前配置（{savedAssignee}，未在人员列表中）</option>}
              {query.data.assignmentPeople.map(person => <option key={person.employeeId} value={person.employeeId}>{person.name}（{person.employeeId}）</option>)}
            </select>
            <small id="assigneeHelp">{query.data.assignmentPeople.length ? '候选人员在“分配规则”中维护。' : '暂无候选人员，请先在“分配规则”中添加。'}</small>
          </label>
          <label htmlFor="configOperator"><span id="operatorLabel">扩展数据源操作人</span>
            <input id="configOperator" aria-labelledby="operatorLabel" aria-describedby="operatorHelp" name="operatorId" defaultValue={config.operatorId || ''} autoComplete="off" />
            <small id="operatorHelp">仅在扩展数据源流程流转时使用，可留空。</small>
          </label>
          <label className={styles.check}><input name="selfOnly" type="checkbox" defaultChecked={Boolean(config.selfOnly)} /><span>只看当前个人 Token 数据</span></label>
        </div>
      </section>
      <section className={styles.section} aria-labelledby="syncHeading">
        <div className={styles.sectionHeading}><h3 id="syncHeading">定时同步</h3><p>按设定间隔拉取数据源更新。</p></div>
        <div className={styles.fields}>
          <label><span id="intervalLabel">轮询间隔（分钟）</span><input aria-labelledby="intervalLabel" aria-describedby="intervalHelp" name="intervalMinutes" type="number" min="1" max="240" defaultValue={config.intervalMinutes ?? ''} /><small id="intervalHelp">支持 1–240 分钟，保存后生效。</small></label>
          <div className={styles.scheduler}>
            <div><strong>{query.data.scheduler.enabled ? '定时同步已开启' : '定时同步已关闭'}</strong><small>服务重启后默认关闭。</small></div>
            <button className="button secondary" type="button" disabled={busy} onClick={() => scheduler.mutate(!query.data.scheduler.enabled)}>{query.data.scheduler.enabled ? '关闭定时' : '开启定时'}</button>
          </div>
        </div>
      </section>
      <section className={styles.section} aria-labelledby="assignmentHeading">
        <div className={styles.sectionHeading}><h3 id="assignmentHeading">智能分配</h3><p>根据候选人员与职责生成建议。</p></div>
        <div className={styles.fields}>
          <label className={styles.check}><input name="enableAIAssignment" aria-labelledby="aiAssignmentLabel" aria-describedby="aiAssignmentHelp" type="checkbox" defaultChecked={Boolean(config.enableAIAssignment)} /><span><span id="aiAssignmentLabel">开启 AI 分配建议</span><small id="aiAssignmentHelp">同步后生成经办人建议。</small></span></label>
          <label className={styles.check}><input name="enableAutoAssignment" aria-labelledby="autoAssignmentLabel" aria-describedby="autoAssignmentHelp" type="checkbox" defaultChecked={Boolean(config.enableAutoAssignment)} /><span><span id="autoAssignmentLabel">开启自动分配</span><small id="autoAssignmentHelp">将可用建议自动应用到数据源。</small></span></label>
          <label>AI 分配模型<select name="aiAssignmentModel" defaultValue={selectedModel}>
            {!selectedModel && <option value="">使用服务端配置</option>}
            {legacyModel && <option value={legacyModel}>当前配置（{legacyModel}）</option>}
            {AI_ASSIGNMENT_MODELS.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
          </select></label>
        </div>
      </section>
      <details className={styles.advanced}>
        <summary>高级配置<span>模型连接与执行目录</span></summary>
        <div className={styles.fields}>
          <label>OpenAI Base URL<input name="openaiBaseUrl" defaultValue={config.openaiBaseUrl || ''} autoComplete="off" /></label>
          <label>OpenAI 请求超时（ms）<input name="openaiTimeoutMs" type="number" min="5000" max="120000" defaultValue={config.openaiTimeoutMs ?? ''} /></label>
          <div className={styles.fullWidth}>
            {config.workspaceManaged ? <div className={styles.managed}><span>IDE 执行路径</span><code>{config.codexWorkspaceDir || '未配置'}</code><small>工作目录由团队管理员配置；需要调整时请联系管理员。</small></div>
              : <label>IDE 执行路径<input name="codexWorkspaceDir" defaultValue={config.codexWorkspaceDir || ''} autoComplete="off" /></label>}
          </div>
        </div>
      </details>
      <footer className={styles.footer}>
        <p role="status" aria-live="polite">{status}</p>
        <button className="button primary" type="submit" disabled={busy}>{save.isPending ? '正在保存…' : '保存配置'}</button>
      </footer>
    </form>
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
