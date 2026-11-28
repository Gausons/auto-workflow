import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { agentDisplayName } from '../../../shared/agentLabels.js';
import type { AgentProject } from '../../../shared/taskTypes.js';
import { apiRequest } from '../api/client.js';
import { collaborationsPath, useCollaborationWrite } from './collaborationApi.js';
import styles from './CollaborationPanel.module.css';

const targetKey = (project: AgentProject) => JSON.stringify([project.deviceId || 'local', project.id]);
const needsUpgrade = (project: AgentProject) => (project.deviceId || 'local') !== 'local' && project.collaborationSessions !== true;
const available = (project: AgentProject) => project.online !== false && !needsUpgrade(project);
const newAssignment = () => ({ key: crypto.randomUUID(), name: '', target: '', responsibility: '' });
type Assignment = ReturnType<typeof newAssignment>;

export function CreateCollaboration({ workspaceId, onCreated, onCancel }: { workspaceId: string; onCreated(id: string): void; onCancel(): void }) {
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [assignments, setAssignments] = useState(() => [newAssignment(), newAssignment()]);
  const targets = useQuery({
    queryKey: ['group-chat-targets', workspaceId],
    queryFn: ({ signal }) => apiRequest<{ projects: AgentProject[]; localError?: string }>('/api/task-center/codex', { signal }),
    refetchInterval: 15_000,
  });
  const action = useCollaborationWrite(workspaceId, collaborationsPath);
  const projects = targets.data?.projects || [];
  const projectFor = (item: Assignment) => projects.find(project => targetKey(project) === item.target);
  function edit(key: string, fields: Partial<Assignment>) {
    setAssignments(items => items.map(item => item.key === key ? { ...item, ...fields } : item));
  }
  const ready = title.trim() && goal.trim() && assignments.every(item => {
    const project = projectFor(item);
    return item.name.trim() && item.responsibility.trim() && project && available(project);
  });
  function create(event: FormEvent) {
    event.preventDefault();
    if (!ready || action.isPending) return;
    const participants = assignments.map(item => {
      const project = projectFor(item)!;
      return { name: item.name.trim(), responsibility: item.responsibility.trim(), deviceId: project.deviceId || 'local', projectId: project.id };
    });
    action.mutate({ data: { title: title.trim(), goal: goal.trim(), participants } }, { onSuccess: result => onCreated(result.id) });
  }
  return <form className={styles.editor} aria-label="新建协作任务" onSubmit={create}>
    <div className={styles.heading}><h2>新建协作任务</h2><button className={styles.secondary} type="button" disabled={action.isPending} onClick={onCancel}>取消</button></div>
    <fieldset className={styles.formFields} disabled={action.isPending}>
      <label>任务名称<input required maxLength={120} value={title} onChange={event => setTitle(event.target.value)} placeholder="例如，打通订单查询" /></label>
      <label>共同目标<textarea required maxLength={8000} rows={3} value={goal} onChange={event => setGoal(event.target.value)} placeholder="写下各分工共同交付的结果和验收要求" /></label>
      <div className={styles.sectionHead}><h3>设备与分工</h3><p>为每个 Agent 选择源码所在的设备与项目，并写明它负责的部分。</p></div>
      {targets.isPending && <p role="status">正在读取执行目标…</p>}
      {targets.isError && <p role="alert">执行目标加载失败 <button type="button" className={styles.textButton} onClick={() => void targets.refetch()}>重试</button></p>}
      {targets.data?.localError && <p role="alert">本机 Agent 不可用，{targets.data.localError}</p>}
      {targets.isSuccess && !projects.some(available) && <p>{projects.some(needsUpgrade) ? '远端设备需升级连接器并重新连接后，才能启动协作分工。' : '当前没有在线的执行目标。'}<Link to="/devices">连接团队设备</Link></p>}
      {assignments.map((item, index) => <fieldset key={item.key} className={styles.assignment}><legend>分工 {index + 1}</legend>
        <label>分工名称<input required maxLength={40} value={item.name} onChange={event => edit(item.key, { name: event.target.value })} placeholder={index === 0 ? '例如，服务端' : '例如，客户端'} /></label>
        <label>执行目标<select required value={item.target} onChange={event => edit(item.key, { target: event.target.value })}>
          <option value="">选择设备、Agent 与项目</option>
          {projects.map(project => <option key={targetKey(project)} value={targetKey(project)} disabled={!available(project)}>{project.deviceName || project.deviceId || '工作台所在设备'} · {agentDisplayName(project.agent || 'codex')} · {project.name || project.cwd}{project.online === false ? '（离线）' : ''}{needsUpgrade(project) ? '（需升级连接器）' : ''}</option>)}
        </select></label>
        {projectFor(item) && <p className={styles.cwd}>工作目录 <code>{projectFor(item)?.cwd}</code></p>}
        <label className={styles.wide}>职责<textarea required maxLength={2000} rows={2} value={item.responsibility} onChange={event => edit(item.key, { responsibility: event.target.value })} placeholder="写明工作范围及需要交付给其他分工的内容" /></label>
        {assignments.length > 2 && <button className={styles.textButton} type="button" onClick={() => setAssignments(items => items.filter(other => other.key !== item.key))}>移除分工 {index + 1}</button>}
      </fieldset>)}
      {assignments.length < 6 && <button className={styles.secondary} type="button" onClick={() => setAssignments(items => [...items, newAssignment()])}>＋ 添加分工</button>}
    </fieldset>
    {action.error && <p className={styles.error} role="alert">{action.error.message}</p>}
    <div className={styles.formFooter}><span>创建后可分别启动各个分工。</span><button className={styles.primary} disabled={!ready || action.isPending || targets.isError}>创建协作任务</button></div>
  </form>;
}
