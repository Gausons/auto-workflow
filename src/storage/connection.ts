export type SqlValue = string | number | bigint | null | Uint8Array;
export type SqlRow = Record<string, SqlValue>;
export interface Connection {
  prepare(sql: string): {
    get(...params: SqlValue[]): SqlRow | undefined;
    all(...params: SqlValue[]): SqlRow[];
    run(...params: SqlValue[]): unknown;
  };
  exec(sql: string): void;
  close(): void;
}
