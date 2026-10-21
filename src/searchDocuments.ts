import { taskContent } from '../shared/taskContent.js';
import type { TaskCenterData } from '../shared/taskTypes.js';
import type { WorkIssue } from './issueSources/types.js';
import type { SearchDocument } from './searchVectorStore.js';

export function taskSearchDocuments(data: TaskCenterData): SearchDocument[] {
  return data.tasks.map(task => ({ id: task.id, text: [task.title, taskContent(task),
    ...data.sessions.filter(session => task.sessionIds.includes(session.id)).flatMap(session => [session.title, session.cwd, session.agent])].filter(Boolean).join(' ') }));
}
export function bugSearchDocuments(bugs: WorkIssue[]): SearchDocument[] {
  return bugs.map(bug => ({ id: bug.id, keywordText: `${bug.code || bug.id} ${bug.title} ${bug.assignee || ''}`,
    text: [bug.code || bug.id, bug.title, bug.assignee, bug.description, bug.product, bug.category].filter(Boolean).join(' ') }));
}
