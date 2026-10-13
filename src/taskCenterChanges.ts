import { taskCenterCollections, type TaskCenterChangeIds } from '../shared/taskCenterSync.js';
import type { TaskCenterData } from '../shared/taskTypes.js';

export const taskCenterChangeRetention = 256;

export function taskCenterState(data: TaskCenterData) {
  const state = new Map(taskCenterCollections.map(key => [key, new Map((data[key] || []).map(item => [item.id, JSON.stringify(item)]))]));
  // Card visibility changes belong to the device delta, including the synthetic local device.
  for (const id of data.hiddenDeviceIds || []) state.get('devices')!.set(id, JSON.stringify({ device: state.get('devices')!.get(id), cardHidden: true }));
  return state;
}

export function changedTaskCenterIds(before: ReturnType<typeof taskCenterState>, data: TaskCenterData, historyIds: Set<string>): TaskCenterChangeIds {
  const changes: TaskCenterChangeIds = {};
  const after = taskCenterState(data);
  for (const key of taskCenterCollections) {
    const previous = before.get(key)!, current = after.get(key)!;
    const ids = [...new Set([...previous.keys(), ...current.keys()])].filter(id => previous.get(id) !== current.get(id));
    if (key === 'sessions') {
      ids.push(...historyIds);
    }
    if (key === 'sessions' && ids.length) {
      // A managed session can hide an imported history row with the same native identity.
      const changed = new Set(ids), identities = new Set<string>();
      for (const [id, value] of [...previous, ...current]) if (changed.has(id)) {
        const session = JSON.parse(value) as TaskCenterData['sessions'][number];
        identities.add(`${session.deviceId}:${session.nativeId}`);
      }
      for (const [id, value] of [...previous, ...current]) {
        const session = JSON.parse(value) as TaskCenterData['sessions'][number];
        if (identities.has(`${session.deviceId}:${session.nativeId}`)) ids.push(id);
      }
    }
    if (ids.length) changes[key] = [...new Set(ids)];
  }
  return changes;
}
