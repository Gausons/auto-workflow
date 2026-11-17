import { useId, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { AssignmentModelConnectionInput, PublicAssignmentModelConnection } from '../../../shared/assignmentModels.js';
import { apiRequest } from '../api/client.js';
import styles from './SettingsPanels.module.css';

export interface ConnectionDraft {
  id: number;
  baseUrl: string;
  modelsText: string;
  timeout: string;
  original?: PublicAssignmentModelConnection;
  apiKey?: string | null;
}

export function draftModels(modelsText: string) {
  return [...new Set(modelsText.split('\n').map(model => model.trim()).filter(Boolean))];
}

export function connectionInput(draft: ConnectionDraft): AssignmentModelConnectionInput {
  return { baseUrl: draft.baseUrl.trim(), models: draftModels(draft.modelsText), timeoutMs: Number(draft.timeout), apiKey: draft.apiKey };
}

export function modelConnectionDraft(id: number, original?: PublicAssignmentModelConnection): ConnectionDraft {
  return { id, baseUrl: original?.baseUrl ?? '', modelsText: original?.models.join('\n') ?? '', timeout: String(original?.timeoutMs ?? 30000), original };
}

function matchesOriginalUrl(draft: ConnectionDraft) {
  if (!draft.original) return false;
  try { return draft.original.baseUrl === new URL(draft.baseUrl.trim()).href.replace(/\/+$/, ''); }
  catch { return false; }
}

interface ConnectionsProps {
  drafts: ConnectionDraft[];
  activeModel: string;
  busy: boolean;
  onAdd: () => number;
  onEdit: (draft: ConnectionDraft) => void;
  onRemove: (id: number) => void;
}

export function AssignmentModelConnections({ drafts, activeModel, busy, onAdd, onEdit, onRemove }: ConnectionsProps) {
  const [editing, setEditing] = useState<number>();
  const draft = drafts.find(item => item.id === editing);
  return <section className={`${styles.fullWidth} ${styles.connectionList}`} aria-labelledby="modelConnectionsHeading">
    <header className={styles.connectionRow}>
      <h3 id="modelConnectionsHeading">OpenAI Base URL 列表</h3>
      <button type="button" className="button secondary" disabled={busy} onClick={() => setEditing(onAdd())}>添加 Base URL</button>
    </header>
    {drafts.length === 0 && <p className={styles.connectionMeta}>尚未配置模型连接。</p>}
    {drafts.map(item => {
      const models = draftModels(item.modelsText);
      const expanded = item.id === draft?.id;
      return <div className={styles.connectionCard} key={item.id}>
        <div className={styles.connectionRow}>
          <div className={styles.connectionInfo}>
            <strong>{item.baseUrl.trim() || '新建模型连接'}</strong>
            <span className={styles.connectionMeta}>{models.length} 个模型 · {item.apiKey ? '已填写 Key' : item.apiKey !== null && matchesOriginalUrl(item) && item.original?.apiKeyConfigured ? '已配置 Key' : '未填写 Key'}</span>
          </div>
          <div className={styles.connectionActions}>
            <button type="button" className="button secondary" aria-expanded={expanded} disabled={busy} onClick={() => setEditing(expanded ? undefined : item.id)}>{expanded ? '收起' : '编辑'}</button>
            <button type="button" className="button ghost" disabled={busy} onClick={() => onRemove(item.id)}>移除</button>
          </div>
        </div>
        {!expanded && models.length > 0 && <ul className={styles.connectionModels}>{models.map(model => <li key={model}>{model}</li>)}</ul>}
        {expanded && <ConnectionEditor draft={item} activeModel={activeModel} busy={busy} onChange={onEdit} />}
      </div>;
    })}
    <small>编辑完成后，点击「保存配置」应用更改。</small>
  </section>;
}

function ConnectionEditor({ draft, activeModel, busy, onChange }: { draft: ConnectionDraft; activeModel: string; busy: boolean; onChange: ConnectionsProps['onEdit'] }) {
  const helpId = useId();
  const [testModel, setTestModel] = useState(activeModel);
  const [result, setResult] = useState<{ ok: boolean; message: string }>();
  const test = useMutation({
    retry: false,
    gcTime: 0,
    mutationFn: (payload: Record<string, unknown>) => apiRequest<{ ok: true }>('/api/config/model-connection', { method: 'POST', body: JSON.stringify(payload) }),
    onSuccess: () => setResult({ ok: true, message: '连接成功，所选模型可用。' }),
    onError: error => setResult({ ok: false, message: error.message }),
    onSettled: (): void => { test.reset(); }
  });
  const models = draftModels(draft.modelsText);
  const selected = models.includes(testModel) ? testModel : models[0] ?? '';
  const hasSavedKey = matchesOriginalUrl(draft) && draft.original?.apiKeySaved;
  const locked = busy || test.isPending;
  const update = (patch: Partial<ConnectionDraft>) => { setResult(undefined); onChange({ ...draft, ...patch }); };
  return <div className={`${styles.fields} ${styles.connectionEditor}`}>
    <label>OpenAI Base URL<input value={draft.baseUrl} inputMode="url" maxLength={2048} autoComplete="off" autoFocus={!draft.original} readOnly={locked} onChange={event => {
      const baseUrl = event.target.value;
      update({ baseUrl, apiKey: draft.baseUrl.trim().replace(/\/+$/, '') === baseUrl.trim().replace(/\/+$/, '') ? draft.apiKey : undefined });
    }} /></label>
    <div className={styles.keyField}>
      <label>OpenAI API Key<input type="password" maxLength={4096} autoComplete="new-password" value={draft.apiKey ?? ''} aria-describedby={helpId}
        disabled={draft.apiKey === null} readOnly={locked} onChange={event => update({ apiKey: event.target.value || undefined })} /></label>
      <small id={helpId}>{matchesOriginalUrl(draft) && draft.original?.apiKeyConfigured ? '当前地址已有 Key，留空可继续使用。' : '填写此 Base URL 对应的 API Key。'}</small>
      {hasSavedKey && <label className={styles.check}><input type="checkbox" checked={draft.apiKey === null} disabled={locked} onChange={event => update({ apiKey: event.target.checked ? null : undefined })} />移除已保存的 Key</label>}
    </div>
    <label className={styles.fullWidth}>模型 ID（每行一个）<textarea rows={4} value={draft.modelsText} readOnly={locked} onChange={event => update({ modelsText: event.target.value })} /></label>
    <label>OpenAI 请求超时（ms）<input inputMode="numeric" value={draft.timeout} readOnly={locked} onChange={event => update({ timeout: event.target.value })} /></label>
    <label>测试模型<select value={selected} disabled={locked || models.length === 0} onChange={event => { setResult(undefined); setTestModel(event.target.value); }}>
      {models.length === 0 && <option value="">请先填写模型 ID</option>}
      {models.map(model => <option key={model} value={model}>{model}</option>)}
    </select></label>
    <div className={`${styles.connection} ${styles.fullWidth}`}>
      <button type="button" className="button secondary" disabled={locked || !selected || !draft.baseUrl.trim()} onClick={() => {
        const { baseUrl, apiKey, timeoutMs } = connectionInput(draft);
        setResult(undefined);
        test.mutate({ openaiBaseUrl: baseUrl, openaiApiKey: apiKey, openaiTimeoutMs: timeoutMs, aiAssignmentModel: selected });
      }}>{test.isPending ? '正在测试…' : '测试连接'}</button>
      {(test.isPending || result) && <p role="status" data-success={result?.ok}>{result?.message || '正在连接模型服务…'}</p>}
    </div>
  </div>;
}
