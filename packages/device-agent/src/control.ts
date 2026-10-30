import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile, rename } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export interface ConnectorStatus {
  id: string; pid: number; port: number; origin: string; tenantId: string; userId: string;
  stateDir: string; logFile?: string; status: 'starting' | 'running' | 'stopping' | 'stopped';
}
interface ControlRecord extends ConnectorStatus { secret: string }
const protocol = 'agent-workbench-connector';
export const connectorDirectory = (root: string) => path.join(root, '.workflow-data', 'connectors');

function validRecord(value: unknown): value is ControlRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' && /^[a-f0-9]{24}$/.test(record.id) && Number.isSafeInteger(record.pid) && Number(record.pid) > 0 &&
    Number.isSafeInteger(record.port) && Number(record.port) >= 1024 && Number(record.port) <= 65535 &&
    typeof record.secret === 'string' && /^[A-Za-z0-9_-]{43}$/.test(record.secret) && typeof record.stateDir === 'string' &&
    typeof record.origin === 'string' && typeof record.tenantId === 'string' && typeof record.userId === 'string' &&
    ['starting', 'running', 'stopping', 'stopped'].includes(String(record.status)) &&
    (record.logFile === undefined || typeof record.logFile === 'string');
}

async function readRecord(root: string, id: string): Promise<ControlRecord> {
  if (!/^[a-f0-9]{24}$/.test(id)) throw new Error('连接标识无效，请先运行 --status');
  const value: unknown = JSON.parse(await readFile(path.join(connectorDirectory(root), `${id}.json`), 'utf8'));
  if (!validRecord(value) || value.id !== id) throw new Error('本机连接器状态文件无效，请核对状态目录');
  return value;
}

async function command(record: ControlRecord, action: 'status' | 'stop'): Promise<ConnectorStatus> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: record.port });
    socket.setEncoding('utf8');
    let input = '';
    const fail = () => { socket.destroy(); reject(new Error('连接器控制通道不可用')); };
    socket.setTimeout(1500, fail);
    socket.once('error', fail);
    socket.once('connect', () => socket.write(JSON.stringify({ protocol, id: record.id, secret: record.secret, action }) + '\n'));
    socket.on('data', chunk => {
      input += String(chunk);
      if (input.length > 16_384) { fail(); return; }
      if (!input.includes('\n')) return;
      try {
        const response = JSON.parse(input.slice(0, input.indexOf('\n'))) as { protocol?: string; status?: ConnectorStatus };
        if (response.protocol !== protocol || response.status?.id !== record.id || response.status.pid !== record.pid) { fail(); return; }
        socket.destroy(); resolve(response.status);
      } catch { fail(); }
    });
    socket.once('end', () => { if (!input.includes('\n')) fail(); });
  });
}

export async function listConnectors(root: string): Promise<ConnectorStatus[]> {
  let files: string[];
  try { files = await readdir(connectorDirectory(root)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  return Promise.all(files.filter(file => /^[a-f0-9]{24}\.json$/.test(file)).sort().map(async file => {
    const record = await readRecord(root, file.slice(0, -5));
    const { secret: _secret, ...saved } = record;
    try { return await command(record, 'status'); }
    catch { return { ...saved, status: 'stopped' as const }; }
  }));
}

export async function stopConnector(root: string, id: string) {
  const record = await readRecord(root, id);
  try { await command(record, 'status'); }
  catch { return false; }
  await command(record, 'stop');
  for (let attempt = 0; attempt < 100; attempt++) {
    await delay(100);
    try { await command(record, 'status'); }
    catch { return true; }
  }
  throw new Error('已请求正常停止，连接器仍在清理执行状态；请稍后运行 --status 核对，不要重复启动');
}

export async function openConnectorControl(options: {
  root: string; stateDir: string; identity: { origin: string; tenantId: string; userId: string }; logFile?: string; stop(): void;
}) {
  const id = createHash('sha256').update(options.stateDir).digest('hex').slice(0, 24);
  // The OS owns the lease: it is released even after a crash, and no stored PID is ever killed.
  const port = 20000 + Number.parseInt(id.slice(0, 8), 16) % 40000;
  const record: ControlRecord = { id, pid: process.pid, port, ...options.identity, stateDir: options.stateDir,
    logFile: options.logFile, status: 'starting', secret: randomBytes(32).toString('base64url') };
  const publicStatus = (): ConnectorStatus => { const { secret: _secret, ...status } = record; return status; };
  const server = createServer(socket => {
    socket.setEncoding('utf8');
    let input = '';
    socket.setTimeout(1500, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('data', chunk => {
      input += String(chunk);
      if (input.length > 4096) { socket.destroy(); return; }
      if (!input.includes('\n')) return;
      try {
        const request = JSON.parse(input.slice(0, input.indexOf('\n'))) as Record<string, unknown>;
        if (request.protocol !== protocol || request.id !== id || typeof request.secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(request.secret) ||
          !timingSafeEqual(Buffer.from(request.secret), Buffer.from(record.secret)) || !['status', 'stop'].includes(String(request.action))) { socket.destroy(); return; }
        if (request.action === 'stop') { record.status = 'stopping'; options.stop(); }
        socket.end(JSON.stringify({ protocol, status: publicStatus() }) + '\n');
        socket.removeAllListeners('data');
      } catch { socket.destroy(); }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => { server.removeListener('error', reject); resolve(); });
  }).catch(async error => {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    let existing: ConnectorStatus | undefined;
    try { existing = await command(await readRecord(options.root, id), 'status'); } catch { /* An unrelated local service may own the port. */ }
    throw new Error(existing ? `该连接器已在运行（${id}，PID ${existing.pid}）；请先使用 --stop ${id} 正常停止` : `本机连接器控制端口 ${port} 已被占用；请先检查并释放该端口`);
  });
  const filename = path.join(connectorDirectory(options.root), `${id}.json`);
  const save = async () => {
    await writeFile(filename + '.pending', JSON.stringify(record), { mode: 0o600 });
    await rename(filename + '.pending', filename);
  };
  const closeServer = () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  try { await mkdir(connectorDirectory(options.root), { recursive: true, mode: 0o700 }); await save(); }
  catch (error) { await closeServer(); throw error; }
  return {
    info: publicStatus,
    async ready() { record.status = 'running'; await save(); },
    async close() { record.status = 'stopped'; try { await save(); } finally { await closeServer(); } }
  };
}
