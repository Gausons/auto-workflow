import type { AgentProject, Session, TaskCenterData } from '../shared/taskTypes.js';
import { insideRemoteDirectory } from './remoteDirectory.js';

// Only connector-advertised projects can receive an original-session resume.
// The connector checks native history and the canonical directory again locally.
export function remoteContinuationProject(data: TaskCenterData, session: Session): AgentProject | undefined {
  if (session.deviceId === 'local' || session.agent !== 'codex' || session.archived || session.missing ||
      !session.nativeId || !/^[a-f0-9-]{36}$/.test(session.nativeId)) return;
  const device = data.devices.find(item => item.id === session.deviceId);
  if (!device?.capabilities?.resumeCodex) return;
  // Advertised projects authorize their descendants, as in validateTarget on
  // the connector. Prefer an exact project when both it and a parent exist.
  const projects = device.codexProjects?.filter(project => (project.agent || 'codex') === 'codex' && insideRemoteDirectory(project.cwd, session.cwd));
  return projects?.find(project => project.cwd === session.cwd) || projects?.[0];
}
