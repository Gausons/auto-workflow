import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PageHeading } from '../components/PageHeading.js';
import { apiRequest, hasSessionToken } from '../api/client.js';
import { useTaskCenterUpdates } from '../tasks/taskCenterUpdates.js';
import type { AgentProject, Device, DeviceHistorySource, TaskCenterData } from '../../../shared/taskTypes.js';
import { DeviceConnectionGuide } from './DeviceConnectionGuide.js';
import styles from './DevicesPage.module.css';

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const time = (value?: string) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '未知';
const sourceLabels: Record<DeviceHistorySource['status'], string> = { available: '历史目录可读取', unconfigured: '当前账号未配置历史来源', missing: '未找到历史目录', error: '历史目录读取失败', unknown: '历史来源状态未知' };

function LocalDeviceDetails({ device, sessionCount, canExecute }: { device: Device; sessionCount: number; canExecute: boolean }) {
  const targets = useQuery({
    queryKey: ['task-center', 'targets'],
    queryFn: ({ signal }) => apiRequest<{ projects: AgentProject[]; localError?: string | null }>('/api/task-center/codex', { signal }),
    enabled: canExecute && hasSessionToken(), retry: false
  });
  const projects = targets.data?.projects.filter(project => project.deviceId === device.id) || [];
  return <>
    <p className="tc-meta">这里显示运行工作台服务的环境；云端部署时通常为服务器或容器。服务运行不代表 Agent 已连接或可执行。</p>
    <p>当前账号可见会话：{sessionCount} 个</p>
    {device.historySources?.map(source => <p className="tc-meta" key={source.id}>{source.label} · {sourceLabels[source.status]} · {source.sessionCount} 个历史会话{source.skipped > 0 ? ` · ${source.skipped} 项未能读取` : ''}</p>)}
    {sessionCount === 0 && <p className="tc-callout">此环境没有当前账号可见的会话。要查看开发机上的会话，请在开发机运行下方连接器，并登录同一个工作台账号。</p>}
    {canExecute && (targets.isPending ? <p role="status">正在检查执行目标…</p> : targets.isError ? <p role="alert">执行目标读取失败：{errorMessage(targets.error)} <button className="button secondary" type="button" onClick={() => void targets.refetch()}>重试读取执行目标</button></p> : targets.data?.localError ? <p className="tc-callout">本地执行不可用：{targets.data.localError}</p> : projects.length ? <><p>可执行 Agent：{projects.map(project => project.name || project.agent || project.id).join(' · ')}</p><a className="button secondary" href="/tasks/new?deviceId=local">新建本地任务</a></> : <p className="tc-meta">未发现可用的本地执行目标；历史记录可读取不代表 Agent 可执行。</p>)}
  </>;
}

export function DevicesPage() {
  const client = useQueryClient();
  const snapshot = useQuery({
    queryKey: ['task-center', 'snapshot'],
    queryFn: ({ signal }) => apiRequest<TaskCenterData>('/api/task-center', { signal }),
    enabled: hasSessionToken()
  });
  useTaskCenterUpdates(true, snapshot.data?.syncVersion);
  const identity = useQuery({
    queryKey: ['task-center', 'identity'],
    queryFn: ({ signal }) => apiRequest<{ permissions: string[]; user?: { username: string } }>('/api/bootstrap', { signal }),
    enabled: hasSessionToken()
  });
  const data = snapshot.data;
  return <div className={styles.page}>
    <PageHeading title="设备与 Agent" description="查看连接状态与可用执行目标"><button className="button secondary" type="button" disabled={snapshot.isFetching} onClick={() => { void snapshot.refetch(); void client.invalidateQueries({ queryKey: ['task-center', 'targets'] }); }}>刷新</button></PageHeading>
    <div className={styles.content}>{snapshot.isPending ? <p role="status">正在加载设备…</p> : snapshot.isError ? <p role="alert">加载失败：{errorMessage(snapshot.error)} <button className="button secondary" type="button" onClick={() => void snapshot.refetch()}>重试</button></p> : data && (
      <section className={styles.devices}>{data.devices.map(device => <article key={device.id}><div className="tc-actions"><h2>{device.name}</h2><span className="tc-tag">{device.id === 'local' ? '服务运行中' : device.online ? '在线' : '离线'}</span></div>
        <p className="tc-meta">{device.id === 'local' ? '工作台所在设备' : `连接器 · 最近心跳 ${time(device.lastSeen)}`}</p>
        {device.id === 'local' ? <LocalDeviceDetails device={device} sessionCount={data.sessions.filter(session => session.deviceId === device.id && !session.missing).length} canExecute={identity.data?.permissions.includes('work.execute') === true} /> : <p>{device.agents.join(' · ') || '未发现 Agent'}</p>}
        {device.transport === 'connector' && <><p>{device.codexProjects?.length ? `可远程执行 · ${device.codexProjects.length} 个项目` : '仅同步 · 未提供可执行项目'}{device.capabilities?.resumeCodex ? ' · 支持 Codex 原会话续聊' : ''}</p>
          {device.codexProjects?.map(project => <p className="tc-meta" key={project.id}>{project.name} · {project.cwd}</p>)}
          {!device.online && <p className="tc-callout">设备离线，已提交的任务会等待重新连接；执行结果未知时请先核对。</p>}
          {!!device.codexProjects?.length && identity.data?.permissions.includes('work.execute') && <a className="button secondary" href={`/tasks/new?deviceId=${encodeURIComponent(device.id)}`}>新建远端任务</a>}</>}
        </article>)}
        {identity.data?.permissions.includes('work.execute') ? <DeviceConnectionGuide username={identity.data.user?.username} /> : <article><h2>连接本机 Agent</h2><p>当前账号没有接入设备和远程执行任务的权限。</p></article>}
      </section>
    )}</div>
  </div>;
}
