import type { AgentProject } from './taskTypes.js';

const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, character => entities[character] || character);

export interface AgentRunConfig {
  projects: AgentProject[];
  projectIndex: number;
  cwd: string;
  model: string;
  reasoningEffort: string;
}

export const selectedAgentProject = (config: AgentRunConfig) => config.projects[config.projectIndex];
export const runDirectoryName = (cwd: string) => cwd.split(/[\\/]/).filter(Boolean).at(-1) || cwd || '默认目录';
export const runEffortLabel = (value: string) => ({ none: '无', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高', ultra: '极高' } as Record<string, string>)[value] || value;
export const runIcon = (kind: 'folder' | 'device') => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${kind === 'folder' ? '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/><path d="M3 9h18"/>' : '<rect x="4" y="3" width="16" height="14" rx="2"/><path d="M2 20h20M9 17v3m6-3v3"/>'}</svg>`;

export function runModelOptions(config: AgentRunConfig) {
  const project = selectedAgentProject(config), models = project?.models || [];
  return `<option value="">默认模型${project?.defaultModel ? `（${escape(project.defaultModel)}）` : ''}</option>${models.map(model => `<option value="${escape(model.id)}" ${config.model === model.id ? 'selected' : ''}>${escape(model.name || model.id)}</option>`).join('')}`;
}

export function runEffortOptions(config: AgentRunConfig) {
  const project = selectedAgentProject(config), model = (project?.models || []).find(item => item.id === (config.model || project?.defaultModel));
  const efforts = Array.isArray(model?.reasoningEfforts) ? model.reasoningEfforts : project?.reasoningEfforts || [];
  const fallback = model?.defaultReasoningEffort || project?.defaultReasoningEffort;
  return `<option value="">默认强度${fallback ? `（${escape(fallback)}）` : ''}</option>${efforts.map(effort => `<option value="${escape(effort.id)}" ${config.reasoningEffort === effort.id ? 'selected' : ''}>${escape(effort.name || effort.id)}</option>`).join('')}`;
}

export function renderRunContext(config: AgentRunConfig, options: { disabled?: boolean; branch?: string } = {}) {
  const project = selectedAgentProject(config), directories = project?.commonDirectories || [], disabled = options.disabled ? 'disabled' : '';
  const cwd = config.cwd || project?.cwd || '';
  const targets = config.projects.map((item, index) => `<option value="${index}" ${index === config.projectIndex ? 'selected' : ''}>${escape(item.name)} · ${escape(item.deviceName)}${item.online ? '' : '（离线）'}</option>`).join('');
  if (!project) return '<p class="tc-create-hint" role="alert">未发现可用 Agent。</p>';
  return `<details class="tc-config-menu tc-directory-menu" name="create-config">
    <summary title="${escape(cwd || '工作目录')}" aria-label="工作目录：${escape(cwd || '默认目录')}">${runIcon('folder')}<span id="tc-create-directory-name">${escape(runDirectoryName(cwd))}</span><span class="tc-config-chevron" aria-hidden="true">⌄</span></summary>
    <div class="tc-config-panel">
      <label class="tc-create-setting" for="tc-create-cwd">工作目录</label>
      <input id="tc-create-cwd" aria-label="工作目录" value="${escape(config.cwd)}" placeholder="${escape(project.cwd || '输入工作目录')}" maxlength="2000" ${disabled}>
      <div class="tc-actions"><button type="button" class="button secondary" data-tc="create-pick-directory" ${disabled}>选择目录</button><button type="button" class="button ghost" data-tc="create-clear-directory" ${disabled}>使用默认目录</button></div>
      ${directories.length ? `<p class="tc-create-hint">常用目录</p><div class="tc-directory-options">${directories.slice(0, 4).map((path, index) => `<button type="button" data-tc="create-directory" data-id="${index}" title="${escape(path)}" aria-label="${escape(path)}" aria-pressed="${path === cwd}" ${disabled}>${runIcon('folder')}<span>${escape(runDirectoryName(path))}<small>${escape(path)}</small></span></button>`).join('')}</div>` : ''}
    </div>
  </details>
  <label class="tc-target-control" title="执行位置">${runIcon('device')}<select id="tc-create-project" aria-label="执行位置" ${disabled}>${targets}</select></label>${options.branch || ''}`;
}

export function renderRunModel(config: AgentRunConfig, disabled = false) {
  const project = selectedAgentProject(config);
  if (!project) return '';
  const model = (project.models || []).find(item => item.id === (config.model || project.defaultModel));
  const modelLabel = model?.name || config.model || project.defaultModel || '默认模型';
  const effort = config.reasoningEffort || model?.defaultReasoningEffort || project.defaultReasoningEffort || '';
  return `<details class="tc-config-menu tc-model-menu" name="create-config" id="tc-create-model-menu"><summary aria-label="模型与思考强度"><span>${escape(modelLabel)}</span><span class="tc-effort-label">${escape(runEffortLabel(effort) || '默认')}</span><span class="tc-config-chevron" aria-hidden="true">⌄</span></summary><div class="tc-config-panel"><label class="tc-create-setting">模型<select id="tc-create-model" ${disabled ? 'disabled' : ''}>${runModelOptions(config)}</select></label><label class="tc-create-setting">思考强度<select id="tc-create-effort" ${disabled ? 'disabled' : ''}>${runEffortOptions(config)}</select></label><p class="tc-create-hint">${escape(model?.description || '默认选项沿用所选 Agent 的配置。')}</p></div></details>`;
}
