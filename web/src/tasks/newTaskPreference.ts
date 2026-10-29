import { preferenceRecord } from '../api/browserPreference.js';

export interface NewTaskPreference { projectId: string; deviceId: string; cwd: string; model: string; effort: string }
export const defaultNewTaskPreference: NewTaskPreference = { projectId: '', deviceId: '', cwd: '', model: '', effort: '' };
export function parseNewTaskPreference(value: unknown): NewTaskPreference {
  const record = preferenceRecord(value);
  const text = (key: keyof NewTaskPreference, limit = 2000) => typeof record[key] === 'string' && record[key].length <= limit ? record[key] : '';
  return { projectId: text('projectId'), deviceId: text('deviceId'), cwd: text('cwd'), model: text('model', 200), effort: text('effort', 100) };
}
