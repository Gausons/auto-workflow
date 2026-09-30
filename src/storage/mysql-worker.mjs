// Register TypeScript inside the worker (the parent loader is not inherited).
import { register } from 'tsx/esm/api';
register();
await import('./mysql-worker.ts');
