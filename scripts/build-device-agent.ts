import { builtinModules } from 'node:module';
import { chmod, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const outDir = path.join(root, 'packages/device-agent/dist');
await build({
  configFile: false, root, publicDir: false,
  ssr: { noExternal: [/^@auto-workflow\//], external: ['@agentclientprotocol/sdk'] },
  build: {
    ssr: path.join(root, 'packages/device-agent/src/cli.ts'), target: 'node22',
    outDir, emptyOutDir: true, minify: false, sourcemap: false,
    rollupOptions: {
      external: [...builtinModules, ...builtinModules.map(name => `node:${name}`), '@agentclientprotocol/sdk'],
      output: { format: 'es', entryFileNames: 'agent.mjs', banner: '#!/usr/bin/env node' }
    }
  }
});
await copyFile(path.join(root, 'LICENSE'), path.join(outDir, 'LICENSE'));
await chmod(path.join(outDir, 'agent.mjs'), 0o755);
