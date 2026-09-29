import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface DeviceConnectionIdentity { origin: string; tenantId: string; userId: string }

// A journal must never be replayed into a different server, organization or account.
export async function bindDeviceConnection(directory: string, identity: DeviceConnectionIdentity): Promise<void> {
  const filename = path.join(directory, 'connection.json');
  try { await writeFile(filename, JSON.stringify(identity), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const saved: unknown = JSON.parse(await readFile(filename, 'utf8'));
  if (!saved || typeof saved !== 'object' || !('origin' in saved) || !('tenantId' in saved) || !('userId' in saved) ||
      saved.origin !== identity.origin || saved.tenantId !== identity.tenantId || saved.userId !== identity.userId) {
    throw new Error('设备状态目录属于其他工作台或账号；请使用独立的 WORKBENCH_DEVICE_DIR');
  }
}
