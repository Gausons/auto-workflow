import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Optional machine-local integrations are never needed by a fresh public checkout.
const extension = new URL('../../.local/register.ts', import.meta.url);
if (existsSync(fileURLToPath(extension))) await import(extension.href);
