import type { Task, TaskContext } from './taskTypes.js';

type TaskContentInput = { content?: string; context?: Partial<TaskContext>; title?: string };

/** Read a single Markdown body, preserving all non-empty legacy sections. */
export function taskContent(task: TaskContentInput): string {
  if (typeof task?.content === 'string') return task.content;
  const context = task?.context || {};
  const sections: Array<[keyof TaskContext, string]> = [['constraints', '约束'], ['decisions', '已确认结论'], ['next', '下一步'], ['files', '文件与版本']];
  return [context.goal || task?.title || '', ...sections.map(([key, label]) => context[key]?.trim() ? `## ${label}\n\n${context[key]}` : '')].filter(Boolean).join('\n\n');
}
export function taskTitle(content: string): string {
  return (content.split('\n').find(line => line.trim()) || '').trim().replace(/^#{1,6}\s+/, '').slice(0, 120) || '未命名任务';
}
