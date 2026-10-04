import type { HistoryMessage } from './taskTypes.js';

export interface InheritedContextInfo {
  count: number;
  partial?: boolean;
  digest?: string;
  sourceSessionId?: string;
  sourceTitle?: string;
  availability?: 'pending' | 'ready' | 'remote';
  coverage?: { records: number; images: number; partial: boolean };
}

export interface ContextPreviewMessage extends HistoryMessage {
  record: number;
  source: string;
  line?: number;
  truncated?: boolean;
}

export interface ContextPreviewResponse {
  messages: ContextPreviewMessage[];
  total: number;
  offset: number;
  nextOffset: number | null;
  stats: {
    users: number;
    assistants: number;
    tools: number;
    references: number;
    images: number;
    unavailableImages: number;
    truncatedMessages: number;
    unsupportedBlocks: number;
  };
  excerpts: Array<{ record: number; role: string; text: string; source: string; line?: number }>;
}
