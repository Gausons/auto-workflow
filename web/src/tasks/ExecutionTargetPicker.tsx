import { useState } from 'react';
import { agentDisplayName } from '../../../shared/agentLabels.js';
import type { AgentProject } from '../../../shared/taskTypes.js';
import { DismissibleDetails } from '../components/DismissibleDetails.js';
import { runDirectoryName } from './agentRunConfig.js';
import styles from './ExecutionTargetPicker.module.css';

const deviceId = (project: AgentProject) => project.deviceId || 'local';
const deviceName = (project: AgentProject) => project.deviceName || '工作台所在设备';
const agentId = (project: AgentProject) => project.agent || 'codex';
function projectName(project: AgentProject) {
  const agent = agentId(project);
  return project.name && project.name !== agentDisplayName(agent) && project.name !== agent ? project.name : runDirectoryName(project.cwd);
}

const empty = { device: '', agent: '', project: '' };

export function ExecutionTargetPicker({ projects, project, disabled, onSelect }: {
  projects: AgentProject[];
  project?: AgentProject;
  disabled: boolean;
  onSelect: (project: AgentProject) => void;
}) {
  const [selection, setSelection] = useState(empty);
  const devices = new Map(projects.map(item => [deviceId(item), item]));
  const byProjectId = new Map<string, AgentProject>();
  for (const item of projects) {
    if (deviceId(item) === selection.device && !byProjectId.has(item.id)) byProjectId.set(item.id, item);
  }
  const deviceProjects = [...byProjectId.values()];
  const agents = [...new Set(deviceProjects.map(agentId))];
  const agentProjects = deviceProjects.filter(item => agentId(item) === selection.agent);
  const selected = agentProjects.find(item => item.id === selection.project);
  const names = new Map<string, number>();
  for (const item of agentProjects) {
    const name = projectName(item);
    names.set(name, (names.get(name) || 0) + 1);
  }
  const label = project ? `${deviceName(project)}${project.online === false ? '（离线）' : ''} · ${agentDisplayName(agentId(project))} · ${projectName(project)}` : '选择执行位置';

  return <DismissibleDetails className={`tc-config-menu ${styles.picker}`} name="create-config" onKeyDown={event => {
    if (event.key === 'Escape' && event.currentTarget.open) {
      event.preventDefault();
      event.currentTarget.open = false;
      event.currentTarget.querySelector('summary')?.focus();
    }
  }}>
    <summary role="button" aria-label="执行位置" aria-disabled={disabled || undefined} title={label} onClick={event => {
      if (disabled) { event.preventDefault(); return; }
      if (!event.currentTarget.closest('details')?.open) setSelection(project ? { device: deviceId(project), agent: agentId(project), project: project.id } : empty);
    }}>▣ <span>{label}</span><span aria-hidden="true">⌄</span></summary>
    <div className={`tc-config-panel ${styles.panel}`}>
      <fieldset className={styles.fields} disabled={disabled} aria-label="选择执行位置">
        <label className="tc-create-setting">设备<select value={selection.device} onChange={event => setSelection({ ...empty, device: event.target.value })}>
          <option value="" disabled>选择设备</option>
          {[...devices].map(([id, item]) => <option key={id} value={id}>{deviceName(item)}{item.online === false ? '（离线）' : ''}</option>)}
        </select></label>
        <label className="tc-create-setting">Agent<select value={selection.agent} disabled={!agents.length} onChange={event => setSelection(previous => ({ ...previous, agent: event.target.value, project: '' }))}>
          <option value="" disabled>选择 Agent</option>
          {agents.map(agent => <option key={agent} value={agent}>{agentDisplayName(agent)}</option>)}
        </select></label>
        <label className="tc-create-setting">项目<select value={selection.project} disabled={!agentProjects.length} onChange={event => setSelection(previous => ({ ...previous, project: event.target.value }))}>
          <option value="" disabled>选择项目</option>
          {agentProjects.map(item => {
            const name = projectName(item);
            return <option key={item.id} value={item.id} title={item.cwd}>{name}{(names.get(name) || 0) > 1 ? ` · ${item.cwd}` : ''}</option>;
          })}
        </select></label>
        <button className="button secondary" type="button" disabled={!selected} onClick={event => {
          if (!selected) return;
          const details = event.currentTarget.closest('details');
          if (details) { details.open = false; details.querySelector('summary')?.focus(); }
          if (selected !== project) onSelect(selected);
        }}>确定</button>
      </fieldset>
    </div>
  </DismissibleDetails>;
}
