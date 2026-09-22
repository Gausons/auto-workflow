import type { Environment } from '../issueSources/types.js';

export type JsonObject = Record<string, unknown>;

export interface HistoryImage {
  dataUrl?: string;
  unavailable?: boolean;
  alt: string;
}

export interface HistoryEntry {
  role: string;
  text: string;
  timestamp?: string;
  turnId?: string;
  name?: string;
  callId?: string;
  images: HistoryImage[];
}

export interface DecodedHistoryRow {
  id?: unknown;
  cwd?: unknown;
  createdAt?: unknown;
  title?: unknown;
  model?: unknown;
  branch?: unknown;
  status?: unknown;
  fallback?: boolean;
  entries?: HistoryEntry[];
}

export interface HistoryAdapter {
  id: string;
  label: string;
  roots(environment: Environment, tenantId: string): string[];
  decode(row: JsonObject): DecodedHistoryRow;
}

export interface HistorySession {
  [key: string]: unknown;
  id: string;
  agent: string;
  agentLabel: string;
  deviceId: 'local';
  sessionId: string;
  title: string;
  cwd: string;
  workspaces: string[];
  model: string;
  branch: string;
  status: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  partial: boolean;
  messages?: HistoryEntry[];
}
