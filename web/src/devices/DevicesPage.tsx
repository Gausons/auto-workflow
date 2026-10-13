import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PageHeading } from '../components/PageHeading.js';
import { apiRequest, hasSessionToken } from '../api/client.js';
import { useTaskCenterUpdates } from '../tasks/taskCenterUpdates.js';
import type { AgentProject, Device, DeviceHistorySource, TaskCenterData } from '../../../shared/taskTypes.js';
import { DeviceConnectionGuide } from './DeviceConnectionGuide.js';
import styles from './DevicesPage.module.css';

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const time = (value?: string) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '未知';
const sourceLabels: Record<DeviceHistorySource['status'], string> = { available: '历史目录可读取', unconfigured: '当前账号未配置历史来源', missing: '未找到历史目录', error: '历史目录读取失败', unknown: '历史来源状态未知' };
const agentLabel = (agent: string) => ({ codex: 'Codex', claude: 'Claude Code' })[agent] || agent;

function DeviceIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 21h8m-4-5v5" /></svg>;
}

function LocalDeviceDetails({ device, sessionCount, canExecute }: { device: Device; sessionCount: number; canExecute: boolean }) {
  const targets = useQuery({
    queryKey: ['task-center', 'targets'],
    queryFn: ({ signal }) => apiRequest<{ projects: AgentProject[]; localError?: string | null }>('/api/task-center/codex', { signal }),
    enabled: canExecute && hasSessionToken(), retry: false
  });
  const projects = targets.data?.projects.filter(project => project.deviceId === device.id) || [];
  return <>
    {canExecute && (targets.isPending ? <p role="status">正在检查执行目标…</p> : targets.isError ? <p role="alert">执行目标读取失败：{errorMessage(targets.error)} <button type="button" className={styles.textButton} onClick={() => void targets.refetch()}>重试读取执行目标</button></p> : targets.data?.localError ? <p className={styles.notice}>本地执行不可用：{targets.data.localError}</p> : projects.length ? <p>可执行 Agent：{projects.map(project => project.name || project.agent || project.id).join(' · ')}</p> : <p>未发现可用的本地执行目标；历史记录可读取不代表 Agent 可执行。</p>)}
    <p>当前账号可见会话：{sessionCount} 个</p>
    {device.historySources?.map(source => <p key={source.id}>{source.label} · {sourceLabels[source.status]} · {source.sessionCount} 个历史会话{source.skipped > 0 ? ` · ${source.skipped} 项未能读取` : ''}</p>)}
    {!!projects.length && <a className={styles.taskLink} href="/tasks/new?deviceId=local">新建本地任务 <span aria-hidden="true">↗</span></a>}
  </>;
}

export function DevicesPage() {
  const client = useQueryClient();
  const [guideOpen, setGuideOpen] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const snapshot = useQuery({
    queryKey: ['task-center', 'snapshot'],
    queryFn: ({ signal }) => apiRequest<TaskCenterData>('/api/task-center', { signal }),
    enabled: hasSessionToken()
  });
  useTaskCenterUpdates(true, snapshot.data?.syncVersion);
  const identity = useQuery({
    queryKey: ['task-center', 'identity'],
    queryFn: ({ signal }) => apiRequest<{ permissions: string[]; user?: { id: string; username: string } }>('/api/bootstrap', { signal }),
    enabled: hasSessionToken()
  });
  const canExecute = identity.data?.permissions.includes('work.execute') === true;
  const canManage = (device: Device) => canExecute && (device.id === 'local' || !!device.owner && device.owner === identity.data?.user?.id);
  const visibility = useMutation({
    mutationFn: ({ deviceId, hidden }: { deviceId: string; hidden: boolean }) => apiRequest('/api/task-center', { method: 'POST', body: JSON.stringify({ action: hidden ? 'remove-device-card' : 'restore-device-card', deviceId }) }),
    retry: false,
    onSuccess: async (_result, { deviceId, hidden }) => {
      await client.cancelQueries({ queryKey: ['task-center', 'snapshot'] });
      client.setQueryData<TaskCenterData>(['task-center', 'snapshot'], current => current && ({ ...current, devices: current.devices.map(device => device.id === deviceId ? { ...device, cardHidden: hidden } : device) }));
      setRemoving(null);
      await client.invalidateQueries({ queryKey: ['task-center', 'snapshot'] });
    }
  });
  const devices = (snapshot.data?.devices || []).filter(device => device.id !== 'local' || device.localExecutionEnabled !== false);
  const visible = devices.filter(device => !device.cardHidden);
  const hidden = devices.filter(device => device.cardHidden && canManage(device));
  const online = visible.filter(device => device.online).length;
  return <div className={styles.page}>
    <PageHeading title="设备与 Agent" description="你的开发设备，随时连接">
      <button className="button secondary" type="button" disabled={snapshot.isFetching} onClick={() => { void snapshot.refetch(); void client.invalidateQueries({ queryKey: ['task-center', 'targets'] }); }}>刷新</button>
      {canExecute && <button className="button" type="button" aria-expanded={guideOpen} aria-controls="device-connection-guide" onClick={() => setGuideOpen(open => !open)}>{guideOpen ? '收起连接指南' : '连接设备'}</button>}
    </PageHeading>
    <div className={styles.content}>
      {guideOpen && canExecute && <section id="device-connection-guide" className={styles.guide}><DeviceConnectionGuide username={identity.data?.user?.username} /></section>}
      {visibility.isError && <p className={styles.notice} role="alert">操作失败：{errorMessage(visibility.error)}</p>}
      {snapshot.isPending ? <p role="status">正在加载设备…</p> : snapshot.isError ? <p role="alert">加载失败：{errorMessage(snapshot.error)} <button className="button secondary" type="button" onClick={() => void snapshot.refetch()}>重试</button></p> : <>
        <div className={styles.summary}><h2>我的设备 <span>{visible.length}</span></h2><p><i className={styles.dot} data-online="true" />{online} 在线<span className={styles.separator}>/</span>{visible.length - online} 离线</p></div>
        {visible.length ? <section className={styles.devices} aria-label="设备列表">{visible.map(device => <article className={styles.card} key={device.id} aria-label={device.name}>
          <div className={styles.cardHeader}><span className={styles.deviceIcon}><DeviceIcon /></span><span className={styles.status} data-online={!!device.online}><i className={styles.dot} data-online={!!device.online} />{device.online ? '在线' : '离线'}</span>
            {canManage(device) && <button className={styles.deleteButton} type="button" aria-label={`删除 ${device.name} 卡片`} title="删除卡片" disabled={visibility.isPending} onClick={() => { visibility.reset(); setRemoving(device.id); }}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7m4-7v7" /></svg></button>}
          </div>
          <h3 title={device.name}>{device.name}</h3>
          <p className={styles.meta}>{device.id === 'local' ? '本机设备' : `最近连接 ${time(device.lastSeen)}`}</p>
          <div className={styles.agents}>{device.agents.length ? device.agents.map(agent => <span key={agent}>{agentLabel(agent)}</span>) : <span>未发现 Agent</span>}</div>
          {removing === device.id ? <div className={styles.confirmation}><p>删除此卡片？设备连接、历史会话和任务会保留。</p><div><button className={styles.textButton} type="button" disabled={visibility.isPending} onClick={() => { setRemoving(null); visibility.reset(); }}>取消</button><button className={styles.dangerButton} type="button" disabled={visibility.isPending} onClick={() => visibility.mutate({ deviceId: device.id, hidden: true })}>{visibility.isPending ? '正在删除…' : '确认删除'}</button></div></div> : <>
            <div className={styles.cardFooter}><span>{device.id === 'local' ? '本地执行' : device.codexProjects?.length ? `${device.codexProjects.length} 个执行项目` : '仅同步'}</span>{device.transport === 'connector' && !!device.codexProjects?.length && canExecute && <a className={styles.taskLink} href={`/tasks/new?deviceId=${encodeURIComponent(device.id)}`}>新建远端任务 <span aria-hidden="true">↗</span></a>}</div>
            <details className={styles.details}><summary>设备详情</summary>{device.id === 'local' ? <LocalDeviceDetails device={device} sessionCount={snapshot.data?.sessions.filter(session => session.deviceId === device.id && !session.missing).length || 0} canExecute={canExecute} /> : <>
              {device.capabilities?.resumeCodex && <p>支持 Codex 原会话续聊</p>}
              {device.codexProjects?.map(project => <p key={project.id}>{project.name} · {project.cwd}</p>)}
              {!device.online && <p>设备离线，已提交的任务会等待重新连接；执行结果未知时请先核对。</p>}
            </>}</details>
          </>}
        </article>)}</section> : <div className={styles.empty}><span className={styles.emptyIcon}><DeviceIcon /></span><h3>还没有设备卡片</h3><p>{canExecute ? '连接你的开发机，在这里查看设备状态与可用 Agent。' : '设备接入后，将在这里显示在线状态。'}</p>{canExecute && <button className="button secondary" type="button" onClick={() => setGuideOpen(true)}>连接第一台设备</button>}</div>}
        {!!hidden.length && <details className={styles.removed}><summary>已删除的卡片 · {hidden.length}</summary>{hidden.map(device => <div key={device.id}><span>{device.name}</span><button className={styles.textButton} type="button" disabled={visibility.isPending} onClick={() => visibility.mutate({ deviceId: device.id, hidden: false })}>恢复 {device.name}</button></div>)}</details>}
      </>}
    </div>
  </div>;
}
