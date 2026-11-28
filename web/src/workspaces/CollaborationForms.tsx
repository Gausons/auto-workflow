import { useState, type FormEvent } from 'react';
import type { CollaborationDetail, CollaborationParticipant, CollaborationRun } from '../../../shared/collaborationTypes.js';
import { collaborationPath, useCollaborationWrite } from './collaborationApi.js';
import styles from './CollaborationPanel.module.css';

interface DraftProps {
  workspaceId: string;
  collaboration: CollaborationDetail;
  onClose(): void;
  onSaved(): void;
}

export function DocumentEditor({ workspaceId, collaboration, source, onClose, onSaved }: DraftProps & { source?: CollaborationRun }) {
  const { participants } = collaboration;
  const [from, setFrom] = useState(source?.participantId || participants[0].id);
  const [to, setTo] = useState(participants.find(person => person.id !== from)!.id);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState(source?.output || '');
  const action = useCollaborationWrite(workspaceId, collaborationPath(collaboration.id) + '/documents');
  function changeFrom(id: string) {
    setFrom(id);
    if (id === to) setTo(participants.find(person => person.id !== id)!.id);
  }
  function publish(event: FormEvent) {
    event.preventDefault();
    if (!title.trim() || !body.trim() || action.isPending) return;
    action.mutate({ data: { fromParticipantId: from, toParticipantId: to, title: title.trim(), body, ...(source ? { sourceExecutionId: source.executionId } : {}) }, revision: collaboration.revision }, { onSuccess: onSaved });
  }
  return <form className={styles.editor} aria-label="编写交接文档" onSubmit={publish}>
    <div className={styles.sectionHead}><h3>编写交接文档</h3><p>写下接收方需要的接口约定、变更说明或待办。发布后，接收方可在启动分工时选用。</p></div>
    {source?.outputTruncated && <p role="status">已载入原输出的前 16000 字符，完整内容可在来源执行中查看。</p>}
    <fieldset className={styles.formFields} disabled={action.isPending}>
      <div className={styles.formPair}>
        <label>来源分工<select value={from} disabled={Boolean(source)} onChange={event => changeFrom(event.target.value)}>{participants.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label>
        <label>接收分工<select value={to} onChange={event => setTo(event.target.value)}>{participants.filter(person => person.id !== from).map(person => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label>
      </div>
      <label>文档标题<input required autoFocus maxLength={120} value={title} onChange={event => setTitle(event.target.value)} placeholder="例如，订单查询接口约定" /></label>
      <label>文档正文<textarea required maxLength={16000} rows={7} value={body} onChange={event => setBody(event.target.value)} placeholder="支持输入 Markdown 文本" /></label>
    </fieldset>
    {action.error && <p className={styles.error} role="alert">{action.error.message}</p>}
    <div className={styles.actions}><button className={styles.primary} disabled={action.isPending || !title.trim() || !body.trim()}>发布文档</button><button className={styles.secondary} type="button" disabled={action.isPending} onClick={onClose}>取消</button></div>
  </form>;
}

export function RunEditor({ workspaceId, collaboration, participant, launchBlocked, onClose, onSaved }: DraftProps & { participant: CollaborationParticipant; launchBlocked: boolean }) {
  const [instruction, setInstruction] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const action = useCollaborationWrite(workspaceId, collaborationPath(collaboration.id) + '/runs');
  const documents = collaboration.documents.filter(doc => doc.toParticipantId === participant.id);
  const selectedLength = documents.reduce((sum, doc) => sum + (selected.includes(doc.id) ? doc.body.length : 0), 0);
  function launch(event: FormEvent) {
    event.preventDefault();
    if (launchBlocked || action.isPending || selectedLength > 100000) return;
    action.mutate({ data: { participantId: participant.id, instruction: instruction.trim(), documentIds: selected }, revision: collaboration.revision }, { onSuccess: onSaved });
  }
  return <form className={styles.runForm} onSubmit={launch} aria-label={participant.name + '的执行配置'}>
    <fieldset className={styles.formFields} disabled={action.isPending || launchBlocked}>
      <label>本轮指令<textarea autoFocus rows={2} maxLength={12000} value={instruction} onChange={event => setInstruction(event.target.value)} placeholder="可选，补充本轮要完成的工作" /></label>
      <fieldset className={styles.documentPicker}><legend>本轮使用的交接文档</legend>
        {documents.length ? documents.map(doc => <label key={doc.id}>
          <input type="checkbox" checked={selected.includes(doc.id)} disabled={!selected.includes(doc.id) && selected.length >= 10}
            onChange={event => setSelected(ids => event.target.checked ? [...ids, doc.id] : ids.filter(id => id !== doc.id))} />{doc.title}
        </label>) : <p>该分工还没有收到文档。</p>}
      </fieldset>
    </fieldset>
    {selectedLength > 100000 && <p className={styles.error} role="alert">所选文档正文总计超过 100000 字符，请减少文档。</p>}
    {launchBlocked && <p role="status">任务或执行状态已更新，请核对当前状态后再启动。</p>}
    {action.error && <p className={styles.error} role="alert">{action.error.message}</p>}
    <div className={styles.actions}><button className={styles.primary} disabled={action.isPending || launchBlocked || selectedLength > 100000}>确认启动</button><button className={styles.secondary} disabled={action.isPending} type="button" onClick={onClose}>取消</button></div>
  </form>;
}
