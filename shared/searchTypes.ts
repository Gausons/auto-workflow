export interface SearchResult {
  ids: string[];
  mode: 'keyword' | 'hybrid';
  warning?: string;
}
