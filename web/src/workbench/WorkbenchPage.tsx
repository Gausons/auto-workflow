import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiRequest, hasSessionToken } from '../api/client.js';

interface Attachment { name?: string; url?: string }
interface Recommendation { status?: string; reason?: string; error?: string; assigneeId?: string; assigneeName?: string }
interface Bug {
  id: string; code?: string; title: string; status?: string; priority?: string; severity?: string;
  assignee?: string; updatedAt?: string; description?: string; expected?: string; actual?: string;
  attachments?: Attachment[]; attachmentsLoaded?: boolean; assignmentRecommendation?: Recommendation;
}
interface Bootstrap {
  bugs: Bug[];
  metrics: { total?: number; pending?: number; processing?: number; resolved?: number };
  scheduler: { lastRunMessage?: string };
  permissions: string[];
}
type Command = 'sync' | 'apply-all' | 'recommend' | 'apply' | 'attachments' | 'task';
interface CommandInput { command: Command; bugId?: string }
type CommandResult = Bootstrap | { bug: Bug } | { attachments: Attachment[] } | { taskId: string; existing?: boolean };

const bootstrapKey = ['bootstrap'] as const;
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

function isWorkbenchRoute() { return location.hash === '#workbench'; }
function safeAttachmentUrl(value: string | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value, location.href);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch { return null; }
}

export function WorkbenchPage() {
  const client = useQueryClient();
  const [active, setActive] = useState(isWorkbenchRoute);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [preview, setPreview] = useState<Attachment | null>(null);
  const [message, setMessage] = useState('');

  useEffect(() => {
    const update = () => setActive(isWorkbenchRoute());
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  useEffect(() => {
    document.body.classList.toggle('preview-open', Boolean(preview));
    return () => document.body.classList.remove('preview-open');
  }, [preview]);

  const query = useQuery({
    queryKey: bootstrapKey,
    queryFn: ({ signal }) => apiRequest<Bootstrap>('/api/bootstrap', { signal }),
    enabled: active && hasSessionToken(),
    refetchInterval: current => {
      const pending = current.state.data?.bugs.some(bug => ['pending', 'assigning'].includes(bug.assignmentRecommendation?.status || ''));
      return active && pending ? 3000 : false;
    },
    refetchIntervalInBackground: false
  });
  const bugs = query.data?.bugs || [];
  const selected = bugs.find(bug => bug.id === selectedId) || bugs[0] || null;
  const canExecute = query.data?.permissions.includes('work.execute') === true;

  const command = useMutation({
    retry: false,
    mutationFn: ({ command, bugId }: CommandInput): Promise<CommandResult> => {
      const id = encodeURIComponent(bugId || '');
      if (command === 'sync') return apiRequest<Bootstrap>('/api/sync', { method: 'POST' });
      if (command === 'apply-all') return apiRequest<Bootstrap>('/api/assignments/apply-all', { method: 'POST', body: '{}' });
      if (command === 'recommend') return apiRequest<{ bug: Bug }>(`/api/bugs/${id}/assignment/recommend`, { method: 'POST', body: '{}' });
      if (command === 'apply') return apiRequest<{ bug: Bug }>(`/api/bugs/${id}/assignment/apply`, { method: 'POST', body: '{}' });
      if (command === 'attachments') return apiRequest<{ attachments: Attachment[] }>(`/api/bugs/${id}/attachments`);
      return apiRequest<{ taskId: string; existing?: boolean }>(`/api/bugs/${id}/task`, { method: 'POST', body: '{}' });
    },
    onSuccess: (result, input) => {
      if ('taskId' in result) {
        window.dispatchEvent(new CustomEvent('bugflow:open-task', { detail: result }));
        return;
      }
      if ('bugs' in result) {
        client.setQueryData(bootstrapKey, result);
        setMessage(input.command === 'sync' ? result.scheduler.lastRunMessage || '同步完成' : '批量分配完成');
        return;
      }
      if ('bug' in result || 'attachments' in result) {
        client.setQueryData<Bootstrap>(bootstrapKey, previous => {
          if (!previous) return previous;
          return { ...previous, bugs: previous.bugs.map(bug => bug.id !== input.bugId ? bug : 'bug' in result
            ? { ...bug, ...result.bug }
            : { ...bug, attachments: result.attachments, attachmentsLoaded: true }) };
        });
        setMessage(input.command === 'apply' ? '分配完成' : '');
      }
    },
    onError: error => setMessage(errorMessage(error))
  });
  const run = (input: CommandInput) => { if (command.isPending) return; setMessage(''); command.mutate(input); };
  const busy = command.isPending;
  const actions = document.querySelector<HTMLElement>('#workbenchActions');
  const previewUrl = safeAttachmentUrl(preview?.url);

  return <>
    {actions && active && createPortal(<>
      <button className="button secondary" type="button" disabled={!canExecute || busy} onClick={() => run({ command: 'apply-all' })}>一键分配</button>
      <button className="button secondary" type="button" disabled={!canExecute || busy} onClick={() => run({ command: 'sync' })}>立即拉取</button>
      <button className="button primary" type="button" disabled={!canExecute || !selected || busy} onClick={() => selected && run({ command: 'task', bugId: selected.id })}>从缺陷生成任务</button>
    </>, actions)}
    <p role="status" aria-live="polite">{message}</p>
    {query.isPending ? <p role="status">正在读取缺陷…</p> : query.isError ?
      <p role="alert">加载失败：{errorMessage(query.error)} <button className="button secondary" type="button" onClick={() => query.refetch()}>重试</button></p> : <>
      <section className="metric-grid" aria-label="缺陷概览">
        {([['total', '缺陷总数'], ['pending', '未处理'], ['processing', '处理中'], ['resolved', '已解决']] as const).map(([key, label]) =>
          <div className="metric" key={key}><span>{label}</span><strong>{query.data?.metrics[key] || 0}</strong></div>)}
      </section>
      <section className="workbench" id="workbench">
        <div className="bug-list-panel">
          <div className="panel-title"><h2>个人缺陷</h2><span>{query.data?.scheduler.lastRunMessage || '尚未同步'}</span></div>
          <div className="bug-list">{bugs.length ? bugs.map(bug => <button className={`bug-item ${bug.id === selected?.id ? 'active' : ''}`} key={bug.id} type="button" onClick={() => { setSelectedId(bug.id); setMessage(''); setPreview(null); }}>
            <strong>{bug.code || bug.id}</strong><span>{bug.title}</span><small>{bug.status || '未知'} · {bug.priority || bug.severity || '未定级'}</small>
          </button>) : <div className="empty">暂无缺陷，点击“立即拉取”。</div>}</div>
        </div>
        <div className="bug-detail-panel">
          <div className="panel-title"><h2>缺陷详情</h2><span>{selected?.code || selected?.id || '未选择'}</span></div>
          <article className="bug-detail">{selected ? <>
            <div className="detail-heading"><div><span className="tag">{selected.status || '未知'}</span><h2>{selected.title}</h2><p>{selected.code || selected.id}</p></div>
              {canExecute && <button className="button primary" type="button" disabled={busy} onClick={() => run({ command: 'task', bugId: selected.id })}>生成任务</button>}</div>
            <dl><div><dt>优先级</dt><dd>{selected.priority || selected.severity || '未填写'}</dd></div>
              <div><dt>经办人</dt><dd>{selected.assignee || '未分配'}</dd></div>
              <div><dt>更新时间</dt><dd>{selected.updatedAt || '未知'}</dd></div></dl>
            <h3>问题描述</h3><p>{selected.description || '未填写'}</p>
            {selected.expected && <><h3>预期结果</h3><p>{selected.expected}</p></>}
            {selected.actual && <><h3>实际结果</h3><p>{selected.actual}</p></>}
            <h3>附件</h3><div className="attachment-list">{selected.attachmentsLoaded
              ? selected.attachments?.length ? selected.attachments.map((item, index) => <button className="button ghost" type="button" key={`${item.name}-${index}`} disabled={!safeAttachmentUrl(item.url)} onClick={() => setPreview(item)}>{item.name || '附件'}</button>) : '无附件'
              : <button className="button ghost" type="button" disabled={busy} onClick={() => run({ command: 'attachments', bugId: selected.id })}>加载附件</button>}</div>
            <h3>分配建议</h3><p>{selected.assignmentRecommendation?.reason || selected.assignmentRecommendation?.error || '尚未生成'}</p>
            {canExecute && <div className="form-actions">
              <button className="button secondary" type="button" disabled={busy} onClick={() => run({ command: 'recommend', bugId: selected.id })}>刷新建议</button>
              {selected.assignmentRecommendation?.assigneeId && <button className="button secondary" type="button" disabled={busy} onClick={() => run({ command: 'apply', bugId: selected.id })}>分配给 {selected.assignmentRecommendation.assigneeName || selected.assignmentRecommendation.assigneeId}</button>}
            </div>}
          </> : <div className="empty">从左侧选择一个缺陷。</div>}</article>
        </div>
      </section>
    </>}
    {preview && previewUrl && createPortal(<div className="attachment-preview-modal" onClick={event => { if (event.target === event.currentTarget) setPreview(null); }}>
      <div className="attachment-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="attachmentPreviewTitle">
        <div className="attachment-preview-header"><strong id="attachmentPreviewTitle">{preview.name || '图片预览'}</strong><div className="attachment-preview-actions">
          <a className="button secondary" href={previewUrl} download>下载</a><button className="preview-close" type="button" aria-label="关闭图片预览" onClick={() => setPreview(null)}>×</button>
        </div></div>
        <div className="attachment-preview-stage"><img src={previewUrl} alt={preview.name || '附件'} /></div>
      </div>
    </div>, document.body)}
  </>;
}
