import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';

/** GUI-launched services may not inherit the terminal PATH. Explicit configuration always wins. */
export function resolveCodexExecutable({ executable, environment = process.env, platform = process.platform, usable = (file: string) => {
  try { accessSync(file, constants.X_OK); return statSync(file).isFile(); } catch { return false; }
} }: { executable?: string; environment?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; usable?: (file: string) => boolean } = {}) {
  const configured = executable && executable !== 'codex' ? executable : environment.CODEX_EXECUTABLE;
  if (configured?.trim()) return configured.trim();
  const home = environment.HOME || environment.USERPROFILE;
  const candidates = (environment.PATH || '').split(platform === 'win32' ? ';' : ':').filter(Boolean).map(dir => path.join(dir, platform === 'win32' ? 'codex.exe' : 'codex'));
  if (platform === 'darwin') {
    for (const base of ['/Applications', ...(home ? [path.join(home, 'Applications')] : [])]) {
      for (const app of ['Codex.app', 'ChatGPT.app']) candidates.push(path.join(base, app, 'Contents', 'Resources', 'codex'));
    }
  }
  return candidates.find(usable) || 'codex';
}
