import { register } from 'tsx/esm/api';
register();
await import('./postgres-worker.ts');
