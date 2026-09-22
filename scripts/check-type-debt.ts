import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const roots = ['src', 'public', 'test', 'scripts'];
const explicitDynamicTypeBudget = 991;
const debtToken = String.fromCharCode(97, 110, 121);
const tokenPattern = new RegExp(`\\b${debtToken}\\b`, 'g');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'build' ? [] : sourceFiles(filename);
    return entry.isFile() && filename.endsWith('.ts') ? [filename] : [];
  });
}

const counts = [...roots.flatMap(sourceFiles), 'server.ts'].map(filename => ({
  filename,
  count: readFileSync(filename, 'utf8').match(tokenPattern)?.length || 0
}));
const total = counts.reduce((sum, item) => sum + item.count, 0);

if (total > explicitDynamicTypeBudget) {
  const additions = counts.filter(item => item.count).sort((left, right) => right.count - left.count).slice(0, 10);
  console.error(`显式 ${debtToken} 类型债务从基线 ${explicitDynamicTypeBudget} 增加到 ${total}。`);
  for (const item of additions) console.error(`${item.count}\t${item.filename}`);
  process.exitCode = 1;
} else {
  console.log(`显式 ${debtToken} 类型债务：${total}/${explicitDynamicTypeBudget}（只能下降，不能增加）`);
}
