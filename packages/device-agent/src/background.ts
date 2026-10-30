import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { runDeviceConnector } from '../../../src/deviceConnector.js';
import { connectorDirectory, openConnectorControl, type ConnectorStatus } from './control.js';

export async function runManagedConnector(environment: NodeJS.ProcessEnv, options: {
  logFile?: string; signal?: AbortSignal; once?: boolean; ready?: (info: ConnectorStatus) => void;
} = {}) {
  const stopping = new AbortController();
  const cancel = () => stopping.abort();
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  let control: Awaited<ReturnType<typeof openConnectorControl>> | undefined;
  try {
    await runDeviceConnector({ environment, stateRoot: homedir(), once: options.once, signal: stopping.signal,
      async onStateDirectory(stateDir, identity) {
        control = await openConnectorControl({ root: homedir(), stateDir, identity, logFile: options.logFile, stop: cancel });
        return () => control!.close();
      },
      async onReady() { await control!.ready(); options.ready?.(control!.info()); }
    });
  } finally { options.signal?.removeEventListener('abort', cancel); }
}

export async function startBackgroundConnector(environment: NodeJS.ProcessEnv, entry: string): Promise<ConnectorStatus> {
  const directory = connectorDirectory(homedir());
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const logFile = path.join(directory, `${randomUUID()}.log`);
  const log = await open(logFile, 'wx', 0o600);
  const inherited = { ...process.env };
  for (const name of ['WORKBENCH_TOKEN', 'WORKBENCH_USERNAME', 'WORKBENCH_PASSWORD']) delete inherited[name];
  try {
    const child = spawn(process.execPath, [...process.execArgv, entry, '--background-worker'], {
      detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd, 'ipc'], env: inherited
    });
    return await new Promise<ConnectorStatus>((resolve, reject) => {
      let finished = false;
      const cancel = () => { if (child.connected) child.send({ type: 'cancel' }, () => {}); };
      const cleanup = () => { clearTimeout(timer); process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); };
      const fail = (message: string) => {
        if (finished) return;
        finished = true; cleanup(); cancel();
        if (child.connected) child.disconnect();
        child.unref();
        reject(new Error(`${message}；未自动重试。日志：${logFile}；请使用 --status 核对后再重新生成命令`));
      };
      const timer = setTimeout(() => fail('后台连接器启动超时'), 90_000);
      process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
      child.once('error', () => fail('无法启动后台连接器'));
      child.once('exit', () => fail('后台连接器未完成启动，请查看日志'));
      child.on('message', (message: unknown) => {
        if (finished || !message || typeof message !== 'object' || !('type' in message)) return;
        if (message.type === 'error' && 'message' in message && typeof message.message === 'string') { fail(message.message); return; }
        if (message.type !== 'ready' || !('info' in message) || !message.info || typeof message.info !== 'object') return;
        finished = true; cleanup();
        if (child.connected) child.disconnect();
        child.unref(); resolve(message.info as ConnectorStatus);
      });
      child.send({ type: 'start', environment, logFile }, error => { if (error) fail('无法传递后台连接配置'); });
    });
  } finally { await log.close(); }
}

export async function runBackgroundWorker() {
  if (!process.send) throw new Error('后台工作进程只能由连接器启动');
  const stopping = new AbortController();
  let ready = false;
  process.on('disconnect', () => { if (!ready) stopping.abort(); });
  process.on('message', message => { if (message && typeof message === 'object' && 'type' in message && message.type === 'cancel') stopping.abort(); });
  const input = await new Promise<{ environment: NodeJS.ProcessEnv; logFile: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('未收到后台连接配置')), 10_000);
    process.once('message', message => {
      clearTimeout(timer);
      if (!message || typeof message !== 'object' || !('type' in message) || message.type !== 'start' || !('environment' in message) || !message.environment || typeof message.environment !== 'object' || !('logFile' in message) || typeof message.logFile !== 'string') { reject(new Error('后台连接配置无效')); return; }
      resolve({ environment: message.environment as NodeJS.ProcessEnv, logFile: message.logFile });
    });
  }).catch(error => { if (process.connected) process.disconnect(); throw error; });
  try {
    await runManagedConnector(input.environment, { logFile: input.logFile, signal: stopping.signal, ready(info) {
      ready = true;
      process.send?.({ type: 'ready', info }, () => {});
    } });
  } catch (error) {
    let message = error instanceof Error ? error.message : '后台连接器执行失败';
    for (const key of ['WORKBENCH_TOKEN', 'WORKBENCH_PASSWORD']) if (input.environment[key]) message = message.replaceAll(input.environment[key]!, '[已隐藏]');
    console.error(message);
    if (process.connected) process.send?.({ type: 'error', message }, () => { if (process.connected) process.disconnect(); });
    process.exitCode = 1;
  } finally { if (process.connected) process.disconnect(); }
}
