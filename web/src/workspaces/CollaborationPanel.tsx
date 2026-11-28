import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { agentAuthenticationMessage } from '../../../shared/agentAuthentication.js';
import { agentDisplayName } from '../../../shared/agentLabels.js';
import { isCollaborationRunUnresolved, type CollaborationDetail, type CollaborationParticipant, type CollaborationRun, type CollaborationSummary } from '../../../shared/collaborationTypes.js';
import type { ExecutionStatus } from '../../../shared/taskTypes.js';
import { apiRequest, ApiError } from '../api/client.js';
import { collaborationKey, collaborationPath, collaborationsPath } from './collaborationApi.js';
import { CreateCollaboration } from './CreateCollaboration.js';
import { DocumentEditor, RunEditor } from './CollaborationForms.js';
import styles from './CollaborationPanel.module.css';

interface PanelProps { workspaceId: string; canExecute: boolean }
const labels: Record<ExecutionStatus, string> = { blocked: '会话被占用', queued: '等待执行', launching: '正在创建会话', running: '执行中', waiting: '等待输入', completed: '本轮已完成', interrupted: '已停止', failed: '执行失败', unknown: '结果待核对' };
const time = (value: string) => new Date(value).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const openTask = (taskId: string) => window.dispatchEvent(new CustomEvent('bugflow:open-task', { detail: { taskId } }));

function ParticipantCard({ workspaceId, canExecute, collaboration, participant, editingDocument, onDocument }: PanelProps & {
  collaboration: CollaborationDetail; participant: CollaborationParticipant; editingDocument: boolean; onDocument(run: CollaborationRun): void;
}) {
  const [starting, setStarting] = useState(false);
  const runs = collaboration.runs.filter(run => run.participantId === participant.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const completed = participant.taskStatus === 'completed';
  const launchBlocked = collaboration.taskStatus === 'completed' || completed || runs.some(isCollaborationRunUnresolved);
  const latest = runs[0];
  const status = completed ? '分工已完成' : latest?.releaseStatus === 'failed' ? '连接释放失败'
    : latest?.releaseStatus === 'releasing' ? '正在释放连接'
    : latest ? labels[latest.status] : '待启动';
  return <article aria-label={participant.name} className={styles.workCard}>
    <header className={styles.cardHeading}><h4>{participant.name}</h4><span role="status" className={styles.status} data-state={completed ? 'completed' : latest?.status}>{status}</span></header>
    <p className={styles.scope}>{participant.responsibility}</p>
    <dl className={styles.target}><dt>执行设备</dt><dd>{participant.deviceName || (participant.deviceId === 'local' ? '工作台所在设备' : participant.deviceId)} · {agentDisplayName(participant.agent)}</dd>
      {participant.projectName && <><dt>执行项目</dt><dd>{participant.projectName}</dd></>}
      <dt>工作目录</dt><dd><code>{participant.cwd}</code></dd></dl>
    {runs.length > 0 && <div className={styles.runs}>
      {runs.map((run, index) => <details key={run.id}><summary><span>第 {runs.length - index} 轮 · {labels[run.status]}</span><time dateTime={run.createdAt}>{time(run.createdAt)}</time></summary>
        {run.instruction && <p className={styles.prose}>{run.instruction}</p>}
        <p className={styles.muted}>交接文档 · {run.documentIds.map(id => collaboration.documents.find(doc => doc.id === id)?.title || id).join('、') || '未使用'}</p>
        {run.status !== 'completed' && run.message && <p>{agentAuthenticationMessage(run.message, participant.agent)}</p>}
        {run.releaseStatus === 'failed' && <p role="alert">会话释放失败，请查看执行。</p>}
        {run.releaseStatus === 'releasing' && <p role="status">正在释放会话连接…</p>}
        {run.output && <pre className={styles.prose}>{run.output}</pre>}
        {run.outputTruncated && <p className={styles.muted}>此处显示输出节选，完整内容可在执行详情中查看。</p>}
        {canExecute && run.status === 'completed' && !isCollaborationRunUnresolved(run) && Boolean(run.output.trim()) && <button type="button" className={styles.secondary} disabled={editingDocument} onClick={() => onDocument(run)}>整理为交接文档</button>}
      </details>)}
    </div>}
    <div className={styles.actions}>
      {canExecute && !starting && <button type="button" className={styles.primary} disabled={launchBlocked} onClick={() => setStarting(true)}>{latest ? '启动下一轮' : '启动分工'}</button>}
      {(latest || completed) && <button type="button" className={styles.textButton} onClick={() => openTask(participant.taskId)}>{completed ? '查看分工任务' : '查看执行'}</button>}
    </div>
    {completed && canExecute && <p className={styles.muted}>可在任务中心重新打开该分工，再继续执行。</p>}
    {canExecute && starting && <RunEditor {...{ workspaceId, collaboration, participant, launchBlocked }} onClose={() => setStarting(false)} onSaved={() => setStarting(false)} />}
  </article>;
}

function TaskDetail({ collaboration, workspaceId, canExecute }: PanelProps & { collaboration: CollaborationDetail }) {
  const [editing, setEditing] = useState<{ source?: CollaborationRun } | null>(null);
  const [notice, setNotice] = useState('');
  const { participants, documents } = collaboration;
  const nameFor = (id: string) => participants.find(person => person.id === id)?.name || id;
  return <>
    <header className={styles.heading}><div><h2>{collaboration.title}</h2><p className={styles.prose}>{collaboration.goal}</p></div><button type="button" className={styles.textButton} onClick={() => openTask(collaboration.parentTaskId)}>查看共同任务 ↗</button></header>
    {collaboration.taskStatus === 'completed' && <p role="status" className={styles.closed}>共同任务已完成。{canExecute && '可在任务中心重新打开共同任务，再启动分工。'}</p>}
    <section aria-label="分工与执行"><div className={styles.sectionHead}><h3>分工与执行</h3></div>
      <div className={styles.workGrid}>{participants.map(person => <ParticipantCard key={person.id} participant={person} editingDocument={Boolean(editing)} {...{ collaboration, workspaceId, canExecute }} onDocument={source => { setNotice(''); setEditing({ source }); }} />)}</div>
    </section>
    <section className={styles.documents} aria-label="交接文档"><div className={styles.heading}><div><h3>交接文档</h3><p>已发布的文档可供指定分工在执行时选用。</p></div>
      {canExecute && !editing && <button type="button" className={styles.secondary} onClick={() => { setNotice(''); setEditing({}); }}>编写交接文档</button>}</div>
      {canExecute && editing && <DocumentEditor key={editing.source?.executionId || 'new'} {...{ collaboration, workspaceId }} source={editing.source} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setNotice('交接文档已发布。'); }} />}
      {notice && <p role="status" className={styles.muted}>{notice}</p>}
      {!documents.length ? <p className={styles.muted}>暂无交接文档。</p> : <div className={styles.documentList}>{documents.slice().reverse().map(doc =>
        <details key={doc.id}><summary><strong>{doc.title}</strong><span>{nameFor(doc.fromParticipantId)} → {nameFor(doc.toParticipantId)}</span><time dateTime={doc.createdAt}>{time(doc.createdAt)}</time></summary>
          {doc.sourceExecutionId && <p className={styles.muted}>整理自{nameFor(doc.fromParticipantId)}的执行输出</p>}
          <pre className={styles.prose}>{doc.body}</pre>
        </details>)}</div>}
    </section>
  </>;
}

export function CollaborationPanel({ workspaceId, canExecute }: PanelProps) {
  const [params, setParams] = useSearchParams();
  const selected = params.get('collaboration') || '';
  function setSelected(id: string) {
    const search = new URLSearchParams(params);
    if (id) { search.set('collaboration', id); search.delete('view'); }
    else { search.delete('collaboration'); search.set('view', 'collaborations'); }
    setParams(search);
  }
  const [creating, setCreating] = useState(false);
  const baseKey = collaborationKey(workspaceId);
  const list = useQuery({
    queryKey: baseKey, queryFn: ({ signal }) => apiRequest<{ collaborations: CollaborationSummary[] }>(collaborationsPath, { signal }),
    enabled: !creating && !selected, refetchInterval: 10_000,
  });
  const detail = useQuery({
    queryKey: [...baseKey, selected], queryFn: ({ signal }) => apiRequest<{ collaboration: CollaborationDetail }>(collaborationPath(selected), { signal }),
    enabled: Boolean(selected), refetchInterval: 3000,
  });
  const unusableDetail = detail.error instanceof ApiError && [401, 403, 404].includes(detail.error.status);
  return <section className={styles.panel} aria-label="协作任务">
    {canExecute && creating ? <CreateCollaboration workspaceId={workspaceId} onCancel={() => setCreating(false)} onCreated={id => { setCreating(false); setSelected(id); }} /> : selected ? <>
      <button type="button" className={styles.back} onClick={() => setSelected('')}>← 全部协作任务</button>
      {detail.isError && <p role="alert">协作任务加载失败，{detail.error.message} <button type="button" onClick={() => void detail.refetch()}>重试</button></p>}
      {detail.isPending && <p role="status">正在读取任务分工…</p>}
      {detail.data && !unusableDetail && <TaskDetail key={selected} workspaceId={workspaceId} collaboration={detail.data.collaboration} canExecute={canExecute} />}
    </> : <>
      <div className={styles.heading}><div><h2>协作任务</h2><p>为同一目标分配设备与 Agent，在各自的项目中执行，通过文档交接成果。</p></div>
        {canExecute && <button type="button" className={styles.primary} onClick={() => setCreating(true)}>新建协作任务</button>}</div>
      {list.isError ? <p role="alert">协作任务加载失败，{list.error.message} <button type="button" onClick={() => void list.refetch()}>重试</button></p>
        : list.isPending ? <p role="status">正在读取协作任务…</p>
        : list.data.collaborations.length ? <div className={styles.taskGrid}>{list.data.collaborations.map(task => <button type="button" key={task.id} className={styles.taskCard} onClick={() => setSelected(task.id)}>
          <strong>{task.title}</strong><p>{task.goal}</p><span>{task.taskStatus === 'completed' && '已完成 · '}{task.participantCount} 个分工 · {task.documentCount} 篇交接文档</span>
        </button>)}</div> : <div className={styles.empty}><h3>暂无协作任务</h3><p>{canExecute ? '可先创建任务，为至少两个分工选择执行项目。' : '团队成员创建后，可在这里查看各设备的分工与交接文档。'}</p></div>}
    </>}
  </section>;
}
