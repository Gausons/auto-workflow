import type { AgentProject, Session, TaskCenterData } from '../shared/taskTypes.js';

// Only connector-advertised projects can receive an original-session resume.
// The connector checks native history and the canonical directory again locally.
export function remoteContinuationProject(data: TaskCenterData, session: Session): AgentProject | undefined {
  if (session.deviceId === 'local' || session.agent !== 'codex' || session.archived || session.missing ||
      !session.nativeId || !/^[a-f0-9-]{36}$/.test(session.nativeId)) return;
  const device = data.devices.find(item => item.id === session.deviceId);
  if (!device?.capabilities?.resumeCodex) return;
  return device.codexProjects?.find(project => (project.agent || 'codex') === 'codex' && project.cwd === session.cwd);
}
