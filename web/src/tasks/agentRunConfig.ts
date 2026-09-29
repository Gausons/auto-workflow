import type { AgentProject } from '../../../shared/taskTypes.js';

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

export function historyRunConfig(projects: AgentProject[], session: { agent: string; cwd?: string; deviceId?: string }): AgentRunConfig {
  const device = session.deviceId || 'local';
  const exact = projects.findIndex(item => item.deviceId === device && item.cwd === session.cwd && (item.agent || 'codex') === session.agent);
  const sameDevice = projects.findIndex(item => item.deviceId === device && (item.agent || 'codex') === session.agent);
  const sameAgent = projects.findIndex(item => (item.agent || 'codex') === session.agent);
  const projectIndex = exact >= 0 ? exact : sameDevice >= 0 ? sameDevice : Math.max(0, sameAgent);
  return { projects, projectIndex, cwd: projects[projectIndex]?.deviceId === device ? session.cwd || '' : '', model: '', reasoningEffort: '' };
}
