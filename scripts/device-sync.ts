import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDeviceConnector } from '../src/deviceConnector.js';

export { deviceConnectorDefaults, deviceStateDirectory, resolveDeviceStateDirectory, syncDeviceOnce } from '../src/deviceConnector.js';

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runDeviceConnector({ once: process.argv.includes('--once') }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
