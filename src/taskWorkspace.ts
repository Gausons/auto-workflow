import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { httpError } from './rbac.js';
const exec = promisify(execFile);
type ErrorLike = Error & { stderr?: string | Buffer };
const asError = (value: unknown): ErrorLike => value instanceof Error ? value as ErrorLike : new Error(String(value));
const git = async (cwd: string, args: string[]) => (await exec('git', ['-C', cwd, ...args], { timeout: 15000, maxBuffer: 2 * 1024 * 1024 })).stdout.replace(/\n$/, '');
async function readGitBranchState(cwd: string) {
  const [refs, status] = await Promise.all([
    git(cwd, ['for-each-ref', '--format=%(HEAD)%09%(refname:short)', 'refs/heads/']),
    git(cwd, ['status', '--porcelain=v1', '-z'])
  ]);
  let current = '';
  const branches = refs.split('\n').filter(Boolean).map(entry => {
    const separator = entry.indexOf('\t');
    if (entry.slice(0, separator) === '*') current = entry.slice(separator + 1);
    return entry.slice(separator + 1);
  });
  const entries = status.split('\0'); let changes = 0;
  for (let index = 0; index < entries.length; index++) { const entry = entries[index]; if (!entry) continue; changes++; if (/^[RC]|^.[RC]/.test(entry)) index++; }
  return { repository: true, current, branches, changes };
}
export async function gitBranches(cwd: string) {
  try { await git(cwd, ['rev-parse', '--show-toplevel']); }
  catch { return { repository: false, current: '', branches: [], changes: 0 }; }
  return readGitBranchState(cwd);
}
export async function switchGitBranch(cwd: string, branch: unknown, create = false) {
  if (typeof branch !== 'string' || !branch || branch.length > 200 || branch.startsWith('-')) throw httpError(400, '分支名称无效');
  try { await git(cwd, ['check-ref-format', `refs/heads/${branch}`]); }
  catch { throw httpError(400, '分支名称无效'); }
  try { await git(cwd, create ? ['switch', '-c', branch] : ['switch', '--no-guess', branch]); }
  catch (caught: unknown) { const error = asError(caught); throw httpError(409, `无法切换分支，未强制覆盖文件：${String(error.stderr || error.message).slice(0, 1500)}`); }
  return readGitBranchState(cwd);
}
export function decodeAttachments(input: unknown) {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 10) throw httpError(400, '最多附加 10 个文件');
  let total = 0;
  return input.map(value => {
    const file = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    if (typeof file.name !== 'string' || !file.name || file.name.length > 255 || /[\\/\x00-\x1f]/.test(file.name) || ['.', '..'].includes(file.name)) throw httpError(400, '附件名称无效');
    if (typeof file.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data) || file.data.length % 4 !== 0) throw httpError(400, '附件编码无效');
    const bytes = Buffer.from(file.data, 'base64');
    if (bytes.toString('base64') !== file.data) throw httpError(400, '附件编码无效');
    total += bytes.length;
    if (bytes.length > 5 * 1024 * 1024 || total > 10 * 1024 * 1024) throw httpError(413, '单文件最多 5 MB，附件总计最多 10 MB');
    return { name: file.name, bytes };
  });
}
export async function saveAttachments(root: string, files: ReturnType<typeof decodeAttachments>) {
  if (!files.length) return { directory: '', files: [] as { name: string; path: string }[] };
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(root, 'task-'));
  try {
    const saved = [];
    for (const [index, file] of files.entries()) {
      const target = path.join(directory, `${index + 1}-${file.name}`);
      await writeFile(target, file.bytes, { flag: 'wx', mode: 0o600 });
      saved.push({ name: file.name, path: target });
    }
    return { directory, files: saved };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}
