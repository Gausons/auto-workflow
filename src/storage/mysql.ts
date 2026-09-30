import { MessageChannel, receiveMessageOnPort, Worker } from 'node:worker_threads';
import type { Connection, SqlRow, SqlValue } from './connection.js';

export interface MysqlConfig { host: string; port: number; user: string; password: string; database: string }
export function mysqlConfig(env: Record<string, string | undefined>): MysqlConfig {
  const { MYSQL_HOST: host, MYSQL_USER: user, MYSQL_PASSWORD: password, MYSQL_DATABASE: database } = env;
  const port = Number(env.MYSQL_PORT || 3306);
  if (!host || !user || !password || !database || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('MySQL 配置不完整：需要 MYSQL_HOST、MYSQL_USER、MYSQL_PASSWORD、MYSQL_DATABASE 和有效端口');
  }
  return { host, port, user, password, database };
}

// Keep existing synchronous transaction callbacks on one dedicated connection.
// No retry: a lost reply may mean a mutation was already committed.
export function openMysql(config: MysqlConfig): Connection {
  const { port1, port2 } = new MessageChannel();
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(new URL('./mysql-worker.mjs', import.meta.url), {
    workerData: { config, port: port2, signal }, transferList: [port2], execArgv: [],
  });
  worker.on('error', () => { /* The bounded RPC reports startup/connection failure without credentials. */ });
  worker.unref(); port1.unref();
  let closed = false;
  function terminate() { closed = true; port1.close(); void worker.terminate(); }
  function call(operation: string, sql = '', params: SqlValue[] = []): unknown {
    if (closed) throw new Error('MySQL 连接已关闭，需重启服务后核对未确认的操作');
    Atomics.store(signal, 0, 0);
    port1.postMessage({ operation, sql, params });
    if (Atomics.wait(signal, 0, 0, 30000) === 'timed-out') {
      terminate(); throw new Error('MySQL 响应超时，操作结果未确认；连接已关闭，不会自动重试');
    }
    const response = receiveMessageOnPort(port1)?.message as { result?: unknown; error?: string; fatal?: boolean } | undefined;
    if (!response) { terminate(); throw new Error('MySQL 工作线程响应丢失，操作结果未确认'); }
    if (response.error) {
      if (response.fatal) terminate();
      throw new Error(response.error);
    }
    return response.result;
  }
  try { call('initialize'); } catch (error) { terminate(); throw error; }
  return {
    prepare: (sql) => ({
      get: (...params) => (call('query', sql, params) as SqlRow[])[0],
      all: (...params) => call('query', sql, params) as SqlRow[],
      run: (...params) => call('query', sql, params),
    }),
    exec: (sql) => { call('exec', sql); },
    close: () => { if (!closed) { try { call('close'); } finally { terminate(); } } },
  };
}
