import type { Session } from '../../../shared/taskTypes.js';

export function canContinueHistory(session: Session): boolean {
  return !session.archived && Boolean(session.managed || session.canContinue ||
    (session.agent === 'codex' && (!session.deviceId || session.deviceId === 'local') && session.sessionId));
}
