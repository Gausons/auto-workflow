import { agentDisplayName } from '../../../shared/agentLabels.js';
import type { AgentProject } from '../../../shared/taskTypes.js';
import { CascadeMenu, type CascadeOption } from '../components/CascadeMenu.js';
import { runDirectoryName } from './agentRunConfig.js';
import styles from './ExecutionTargetPicker.module.css';

const deviceId = (project: AgentProject) => project.deviceId || 'local';
const deviceName = (project: AgentProject) => project.deviceName || '工作台所在设备';
const agentId = (project: AgentProject) => project.agent || 'codex';
function projectName(project: AgentProject) {
  const agent = agentId(project);
  return project.name && project.name !== agentDisplayName(agent) && project.name !== agent ? project.name : runDirectoryName(project.cwd);
}

const levels = ['设备', 'Agent', '项目'];

function executionOptions(projects: AgentProject[]): CascadeOption<AgentProject>[] {
  const devices = new Map<string, Map<string, AgentProject>>();
  for (const project of projects) {
    const id = deviceId(project);
    const targets = devices.get(id) || new Map<string, AgentProject>();
    if (!targets.has(project.id)) targets.set(project.id, project);
    devices.set(id, targets);
  }
  return [...devices].map(([id, targets]) => {
    const first = targets.values().next().value!;
    const agents = new Map<string, AgentProject[]>();
    for (const project of targets.values()) {
      const agent = agentId(project);
      const items = agents.get(agent) || [];
      items.push(project);
      agents.set(agent, items);
    }
    return {
      id, label: deviceName(first) + (first.online === false ? '（离线）' : ''),
      children: [...agents].map(([agent, items]) => {
        const names = new Map<string, number>();
        for (const item of items) {
          const name = projectName(item);
          names.set(name, (names.get(name) || 0) + 1);
        }
        return { id: agent, label: agentDisplayName(agent), children: items.map(item => {
          const name = projectName(item);
          return { id: item.id, label: name, detail: (names.get(name) || 0) > 1 ? item.cwd : undefined, value: item };
        }) };
      })
    };
  });
}

export function ExecutionTargetPicker({ projects, project, disabled, onSelect }: {
  projects: AgentProject[];
  project?: AgentProject;
  disabled: boolean;
  onSelect: (project: AgentProject) => void;
}) {
  const selected = project ? [deviceId(project), agentId(project), project.id] : [];
  const label = project ? [deviceName(project) + (project.online === false ? '（离线）' : ''), agentDisplayName(agentId(project)), projectName(project)].join(' · ') : '选择执行位置';
  return <CascadeMenu options={executionOptions(projects)} levels={levels} label={label} buttonLabel="执行位置" menuLabel="选择执行位置"
    className={styles.picker} above disabled={disabled} selected={selected} onSelect={item => { if (item !== project) onSelect(item); }} />;
}
