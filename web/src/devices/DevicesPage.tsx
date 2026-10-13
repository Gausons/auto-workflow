import { useQuery } from '@tanstack/react-query';
import { PageHeading } from '../components/PageHeading.js';
import { apiRequest, hasSessionToken } from '../api/client.js';
import { useTaskCenterUpdates } from '../tasks/taskCenterUpdates.js';
import type { TaskCenterData } from '../../../shared/taskTypes.js';
import { DeviceConnectionGuide } from './DeviceConnectionGuide.js';
import styles from './DevicesPage.module.css';

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const time = (value?: string) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '未知';

export function DevicesPage() {
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
    <PageHeading title="设备与 Agent" description="查看连接状态与可用执行目标"><button className="button secondary" type="button" disabled={snapshot.isFetching} onClick={() => void snapshot.refetch()}>刷新</button></PageHeading>
    <div className={styles.content}>{snapshot.isPending ? <p role="status">正在加载设备…</p> : snapshot.isError ? <p role="alert">加载失败：{errorMessage(snapshot.error)} <button className="button secondary" type="button" onClick={() => void snapshot.refetch()}>重试</button></p> : data && (
      <section className={styles.devices}>{data.devices.map(device => <article key={device.id}><div className="tc-actions"><h2>{device.name}</h2><span className="tc-tag">{device.online ? '在线' : '离线'}</span></div>
        <p>{device.agents.join(' · ') || '未发现 Agent'}</p><p className="tc-meta">{device.transport === 'manual' ? '工作台所在设备' : `连接器 · 最近心跳 ${time(device.lastSeen)}`}</p>
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
