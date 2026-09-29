import type { CSSProperties } from 'react';
import { runEffortLabel } from './agentRunConfig.js';
import type { AgentProject } from '../../../shared/taskTypes.js';

interface ModelEffortMenuProps {
  project: AgentProject;
  model: string;
  effort: string;
  disabled: boolean;
  onModelChange(model: string): void;
  onEffortChange(effort: string): void;
}

const modelLabel = (name: string) => /^GPT-/i.test(name) ? name.replace(/^GPT-/i, '').replace(/-/g, ' ') : name;

export function ModelEffortMenu({ project, model, effort, disabled, onModelChange, onEffortChange }: ModelEffortMenuProps) {
  const defaultModel = project.models?.find(item => item.id === project.defaultModel);
  const selectedModel = project.models?.find(item => item.id === (model || project.defaultModel));
  const efforts = selectedModel?.reasoningEfforts?.length ? selectedModel.reasoningEfforts : project.reasoningEfforts || [];
  const defaultEffort = selectedModel?.defaultReasoningEffort || project.defaultReasoningEffort || efforts[0]?.id || '';
  const effectiveEffort = effort || defaultEffort;
  const effortIndex = Math.max(0, efforts.findIndex(item => item.id === effectiveEffort));
  const effortProgress = `${effortIndex / Math.max(1, efforts.length - 1) * 100}%`;
  return <details className="tc-config-menu tc-model-menu" name="create-config">
    <summary aria-label="模型与思考强度"><span>{modelLabel(selectedModel?.name || model || project.defaultModel || '默认模型')}</span><span className="tc-effort-label">{effort ? runEffortLabel(effort) : '默认'}</span><span className="tc-model-chevron" aria-hidden="true">⌄</span></summary>
    <div className="tc-config-panel tc-model-panel">
      <div className="tc-model-card-header"><span aria-hidden="true">ϟ</span><strong>{runEffortLabel(effectiveEffort) || '默认'}</strong><button type="button" aria-label="恢复默认思考强度" title="恢复默认思考强度" disabled={disabled || !effort} onClick={() => onEffortChange('')}>↶</button></div>
      <label className="tc-model-select-wrap"><select aria-label="模型" value={model} disabled={disabled} onChange={event => { onModelChange(event.target.value); onEffortChange(''); }}><option value="">{defaultModel ? `${modelLabel(defaultModel.name)}（默认）` : '默认模型'}</option>{project.models?.map(item => <option key={item.id} value={item.id}>{modelLabel(item.name || item.id)}</option>)}</select><span aria-hidden="true">›</span></label>
      <div className="tc-effort-track" style={{ '--tc-effort-progress': effortProgress } as CSSProperties}><input aria-label="思考强度" aria-valuetext={`${runEffortLabel(effectiveEffort) || '默认'}${effort ? '' : '（默认）'}`} type="range" min="0" max={Math.max(0, efforts.length - 1)} step="1" value={effortIndex} disabled={disabled || !efforts.length} onChange={event => onEffortChange(efforts[Number(event.target.value)]?.id || '')} /><span className="tc-effort-ticks" aria-hidden="true">{efforts.map(item => <span key={item.id} />)}</span></div>
      {!efforts.length && <p className="tc-create-hint">当前 Agent 未提供思考强度选项。</p>}
    </div>
  </details>;
}
