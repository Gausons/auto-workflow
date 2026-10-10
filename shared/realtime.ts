import type { TaskCenterUpdate } from './taskCenterSync.js';

export const realtimeProtocol = 'workbench.v1';
export const realtimeMaxPayload = 8_000_000;
export type RealtimeSubscription = { channel: 'task-center'; since: number } | { channel: 'device-control'; deviceId: string };
export type RealtimeEvent = ({ type: 'task-center' } & TaskCenterUpdate) | { type: 'device-control'; version: number };
export interface ExecutionFeedback {
  executionId: string; report: unknown; controlAck?: string; controlError?: unknown;
}
export type SendExecutionFeedback = (input: ExecutionFeedback) => Promise<void>;

export function realtimeUrl(value: URL): URL {
  const url = new URL(value);
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';
  if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error('实时连接地址无效');
  return url;
}

export function realtimeEvent(value: unknown): RealtimeEvent {
  if (!value || typeof value !== 'object' || !('type' in value) || !['task-center', 'device-control'].includes(String(value.type)) ||
      !('version' in value) || !Number.isSafeInteger(value.version) || Number(value.version) < 0) throw new Error('实时同步版本无效');
  return value as RealtimeEvent;
}
