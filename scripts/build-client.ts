import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'public', 'build');

function run(args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn('pnpm', args, { cwd: root, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`pnpm ${args.join(' ')} ${signal ? `被信号 ${signal} 终止` : `退出码 ${code}`}`));
    });
  });
}

await rm(output, { recursive: true, force: true });
await run(['exec', 'tsc', '-p', 'tsconfig.client.json']);
await run(['exec', 'vite', 'build']);
