import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '../api/client.js';
import type { AgentProject } from '../../../shared/taskTypes.js';
import type { GroupChatMessage, GroupChatRoom } from '../../../shared/groupChatTypes.js';
import { waitForRemoteRequest } from '../tasks/remoteRequest.js';
import styles from './GroupChatPanel.module.css';

interface RoomSummary { id: string; name: string; status: string; participants: GroupChatRoom['participants'] }
interface Selection { name: string; target: string; responsibility: string; cwd: string; directoryRequestId: string }
interface DirectoryResult { status: string; requestId?: string; cwd?: string; message?: string }
const messageLabels: Record<GroupChatMessage['status'], string> = { pending: '等待发言', running: '正在回复', completed: '已回复', failed: '回复失败', unknown: '结果待核对', stopped: '已停止' };
const roundLabels: Record<string, string> = { running: '讨论进行中', completed: '等待新话题', blocked: '本轮已中断，请查看执行状态', stopped: '已停止后续发言' };
const targetKey = (project: AgentProject) => JSON.stringify([project.deviceId || 'local', project.id]);
const newSelection = (index: number): Selection => ({ name: `Agent ${index + 1}`, target: '', responsibility: '', cwd: '', directoryRequestId: '' });

export function GroupChatPanel({ workspaceId, canExecute }: { workspaceId: string; canExecute: boolean }) {
  const client = useQueryClient();
  const baseKey = ['group-chats', workspaceId];
  const [selectedId, setSelectedId] = useState('');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [selections, setSelections] = useState<Selection[]>([newSelection(0), newSelection(1)]);
  const [picking, setPicking] = useState<number | null>(null);
  const [directoryStatus, setDirectoryStatus] = useState('');
  const picker = useRef<AbortController | null>(null);
  useEffect(() => () => { picker.current?.abort(); }, []);
  const [draft, setDraft] = useState('');
  const createKey = useRef(''), sendKey = useRef('');
  const messagesRef = useRef<HTMLDivElement>(null), followMessages = useRef(true);
  const rooms = useQuery({ queryKey: baseKey, queryFn: ({ signal }) => apiRequest<{ rooms: RoomSummary[] }>('/api/workspaces/chats', { signal }), refetchInterval: 3000 });
  const roomId = selectedId || rooms.data?.rooms[0]?.id || '';
  const detail = useQuery({ queryKey: [...baseKey, roomId], queryFn: ({ signal }) => apiRequest<{ room: GroupChatRoom }>(`/api/workspaces/chats/${roomId}`, { signal }), enabled: Boolean(roomId), refetchInterval: 1500 });
  const targets = useQuery({ queryKey: ['group-chat-targets', workspaceId], queryFn: ({ signal }) => apiRequest<{ projects: AgentProject[]; localError?: string }>('/api/task-center/codex', { signal }), enabled: canExecute && creating, refetchInterval: 15_000 });
  const action = useMutation({
    mutationFn: ({ path, body }: { path: string; body: unknown }) => apiRequest<{ id: string }>(path, { method: 'POST', body: JSON.stringify(body) }),
    retry: false,
    onSettled: () => { void client.invalidateQueries({ queryKey: baseKey }); },
  });
  useLayoutEffect(() => {
    window.dispatchEvent(new CustomEvent('bugflow:active-group-chat', { detail: { roomId } }));
    return () => { window.dispatchEvent(new CustomEvent('bugflow:active-group-chat', { detail: { roomId: '' } })); };
  }, [roomId]);
  const room = detail.data?.room;
  useLayoutEffect(() => { followMessages.current = true; }, [roomId]);
  useLayoutEffect(() => {
    if (messagesRef.current && followMessages.current) messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
  }, [room]);
  const busy = action.isPending || picking !== null;
  const running = room?.round?.status === 'running';
  const unresolved = room?.messages.some(message => message.status === 'unknown' || message.status === 'running');
  function editSelection(index: number, patch: Partial<Selection>) {
    createKey.current = ''; action.reset();
    setSelections(items => items.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
  }
  async function chooseDirectory(index: number) {
    if (picker.current || action.isPending) return;
    const selection = selections[index];
    const project = targets.data?.projects.find(item => targetKey(item) === selection.target);
    if (!project) return;
    const controller = new AbortController(); picker.current = controller;
    setPicking(index); setDirectoryStatus('请在目标设备选择并确认工作目录。');
    try {
      const { signal } = controller;
      const response = await apiRequest<DirectoryResult>('/api/task-center/directory-picker', { method: 'POST', body: JSON.stringify({ deviceId: project.deviceId || 'local', projectId: project.id }), signal });
      if (['pending', 'selecting'].includes(response.status) && !response.requestId) throw new Error('目录选择结果不完整，请重新选择');
      const result = await waitForRemoteRequest(client, 'directoryRequests', response.requestId || '', response,
        () => apiRequest<DirectoryResult>(`/api/task-center/directory-picker?requestId=${encodeURIComponent(response.requestId || '')}`, { signal }), 300_000, signal);
      if (signal.aborted) return;
      if (result.status === 'cancelled') throw new Error('已取消选择目录');
      if (result.status !== 'completed') throw new Error(result.message || '无法选择目录');
      if (!result.cwd || (project.deviceId !== 'local' && project.deviceId && !response.requestId)) throw new Error('目录选择结果不完整，请重新选择');
      editSelection(index, { cwd: result.cwd, directoryRequestId: response.requestId || '' });
      setDirectoryStatus('');
    } catch (error) {
      if (!controller.signal.aborted) setDirectoryStatus(error instanceof Error ? error.message : '无法选择目录');
    } finally {
      if (picker.current === controller) { picker.current = null; setPicking(null); }
    }
  }
  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    createKey.current ||= crypto.randomUUID();
    const participants = selections.map(selection => {
      const target = targets.data?.projects.find(project => targetKey(project) === selection.target);
      return { name: selection.name, responsibility: selection.responsibility, deviceId: target?.deviceId || 'local', projectId: target?.id || '', cwd: selection.cwd.trim(), ...(selection.directoryRequestId ? { directoryRequestId: selection.directoryRequestId } : {}) };
    });
    try {
      const result = await action.mutateAsync({ path: '/api/workspaces/chats', body: { name, participants, requestId: createKey.current } });
      setSelectedId(result.id); setCreating(false); setName(''); setSelections([newSelection(0), newSelection(1)]); createKey.current = ''; setDraft(''); sendKey.current = '';
    } catch { /* Keep the form and request ID for a deliberate retry. */ }
  }
  async function send(event: React.FormEvent) {
    event.preventDefault(); if (!room) return;
    followMessages.current = true;
    sendKey.current ||= crypto.randomUUID();
    try {
      await action.mutateAsync({ path: `/api/workspaces/chats/${room.id}/messages`, body: { message: draft, requestId: sendKey.current, revision: room.revision } });
      setDraft(''); sendKey.current = '';
    } catch { /* Preserve the draft; mutations are never retried automatically. */ }
  }
  return <section className={styles.panel} aria-label="群组聊天室">
    <div className={styles.heading}><div><h2>群组聊天室</h2><p>让多个 Agent 围绕同一个话题，逐一分享观点、回应彼此。</p></div>{canExecute && <button type="button" disabled={busy} onClick={() => { setCreating(true); action.reset(); }}>＋ 新建聊天室</button>}</div>
    {action.error && <p className={styles.error} role="alert">{action.error.message}</p>}
    {creating && <form className={styles.createForm} onSubmit={event => void create(event)}>
      <label>聊天室名称<input required maxLength={80} value={name} disabled={busy} onChange={event => { setName(event.target.value); createKey.current = ''; action.reset(); }} placeholder="例如：架构方案讨论" /></label>
      <p>选择 2–6 位 Agent，按列表顺序发言。可以为同一个执行目标设置不同名称和职责。</p>
      {targets.isPending ? <p role="status">正在加载可用 Agent…</p> : targets.isError ? <p role="alert">Agent 加载失败 <button type="button" onClick={() => void targets.refetch()}>重试</button></p> : <>
        {targets.data?.localError && <p role="alert">本机 Agent 不可用：{targets.data.localError}</p>}
        {!targets.data?.projects.some(project => project.online !== false) && <p>还没有可用 Agent，请先在设备页面连接团队设备并配置 Agent。</p>}
        {selections.map((selection, index) => <fieldset key={index} disabled={busy} className={styles.participant}><legend>Agent {index + 1}</legend>
          <label>显示名称<input required maxLength={40} value={selection.name} onChange={event => editSelection(index, { name: event.target.value })} /></label>
          <label>执行目标<select required value={selection.target} onChange={event => editSelection(index, { target: event.target.value, cwd: targets.data?.projects.find(item => targetKey(item) === event.target.value)?.cwd || '', directoryRequestId: '' })}><option value="">选择设备与 Agent</option>{targets.data?.projects.map(project => <option key={targetKey(project)} value={targetKey(project)} disabled={project.online === false}>{project.deviceName || '工作台所在设备'} · {project.agent || 'codex'} · {project.name || project.cwd}{project.online === false ? '（离线）' : ''}</option>)}</select></label>
          <div className={styles.directory}><label>工作目录<input required maxLength={2000} value={selection.cwd} disabled={!selection.target} onChange={event => editSelection(index, { cwd: event.target.value, directoryRequestId: '' })} placeholder="选择此 Agent 的工作目录" /></label><div className={styles.actions}><button type="button" disabled={!selection.target} onClick={() => void chooseDirectory(index)}>选择目录</button><button type="button" disabled={!selection.target} onClick={() => editSelection(index, { cwd: targets.data?.projects.find(item => targetKey(item) === selection.target)?.cwd || '', directoryRequestId: '' })}>使用默认目录</button></div></div>
          <label>讨论职责（可选）<input maxLength={1000} value={selection.responsibility} onChange={event => editSelection(index, { responsibility: event.target.value })} placeholder="例如：评估安全风险" /></label>
          {selections.length > 2 && <button type="button" onClick={() => { setSelections(items => items.filter((_, itemIndex) => itemIndex !== index)); createKey.current = ''; }}>移除 Agent {index + 1}</button>}
        </fieldset>)}
      </>}
      {directoryStatus && <p role="status">{directoryStatus}</p>}
      <div className={styles.actions}>{selections.length < 6 && <button type="button" disabled={busy} onClick={() => { setSelections(items => [...items, newSelection(items.length)]); createKey.current = ''; }}>＋ 添加 Agent</button>}<button disabled={busy || targets.isPending || targets.isError || selections.some(selection => !selection.target || !selection.cwd.trim())}>创建聊天室</button><button type="button" disabled={action.isPending} onClick={() => { picker.current?.abort(); picker.current = null; setPicking(null); setCreating(false); action.reset(); setDirectoryStatus(''); }}>取消</button></div>
    </form>}
    {rooms.isPending ? <p role="status">正在加载聊天室…</p> : rooms.isError ? <p role="alert">聊天室加载失败 <button type="button" onClick={() => void rooms.refetch()}>重试</button></p> : !rooms.data?.rooms.length ? <div className={styles.empty}><h3>开启团队的第一场 Agent 讨论</h3><p>{canExecute ? '新建聊天室，邀请不同职责的 Agent 一起分析问题。' : '团队成员创建聊天室后，你可以在这里查看讨论。'}</p></div> : <div className={styles.layout}>
      <nav className={styles.roomList} aria-label="聊天室列表">{rooms.data.rooms.map(item => <button type="button" key={item.id} aria-pressed={roomId === item.id} disabled={busy} onClick={() => { setSelectedId(item.id); setDraft(''); sendKey.current = ''; action.reset(); }}><strong>{item.name}</strong><small>{item.participants.length} 位 Agent · {roundLabels[item.status]}</small></button>)}</nav>
      <div className={styles.chat}>
        {detail.isPending ? <p role="status">正在加载讨论…</p> : detail.isError ? <p role="alert">讨论加载失败 <button type="button" onClick={() => void detail.refetch()}>重试</button></p> : room && <>
          <header><h3>{room.name}</h3><p>{room.participants.map(participant => `${participant.name}（${participant.agent}）`).join(' → ')}</p><ul className={styles.directories}>{room.participants.map(participant => <li key={participant.id}>{participant.name}：{participant.cwd}</li>)}</ul><span role="status">{roundLabels[room.round?.status || 'completed']}</span></header>
          <div ref={messagesRef} onScroll={event => { const element = event.currentTarget; followMessages.current = element.scrollHeight - element.clientHeight - element.scrollTop < 80; }} className={styles.messages} role="log" aria-label="讨论记录" aria-live="polite">{room.messages.length ? room.messages.map(message => <article key={message.id} className={message.role === 'user' ? styles.userMessage : styles.agentMessage}>
            <div className={styles.messageMeta}><strong>{message.authorName}</strong><span>{message.role === 'agent' ? messageLabels[message.status] : '团队成员'}</span></div>
            {message.text && <p>{message.text}</p>}{message.detail && message.status !== 'completed' && <small>{message.detail}</small>}
            {message.executionId && <button type="button" className={styles.executionLink} onClick={() => window.dispatchEvent(new CustomEvent('bugflow:open-task', { detail: { taskId: message.taskId } }))}>查看执行</button>}
          </article>) : <p className={styles.empty}>发送一个话题，开始讨论。</p>}</div>
          {canExecute ? <form className={styles.composer} onSubmit={event => void send(event)}><label htmlFor="group-chat-message">讨论消息</label><textarea id="group-chat-message" required maxLength={12000} rows={3} value={draft} disabled={busy || running || unresolved} onChange={event => { setDraft(event.target.value); sendKey.current = ''; action.reset(); }} placeholder="提出问题，或补充你的观点…" /><div className={styles.actions}><small>每条消息发起一轮讨论。Agent 仅讨论，实际操作需另行发起任务。</small>{(running || unresolved) && <button type="button" disabled={busy || room.round?.status === 'stopped'} onClick={() => action.mutate({ path: `/api/workspaces/chats/${room.id}/stop`, body: { revision: room.revision, roundId: room.round?.id } })}>停止讨论</button>}<button disabled={busy || running || unresolved || !draft.trim()}>发送并开始讨论</button></div></form> : <p className={styles.readOnly}>你当前是只读成员，可以查看群聊记录。</p>}
        </>}
      </div>
    </div>}
  </section>;
}
