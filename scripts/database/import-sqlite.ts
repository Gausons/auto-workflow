import { importSqlite } from '../../src/storage/import-sqlite.js';
import { mysqlConfig } from '../../src/storage/mysql.js';
const filename = process.argv[2];
if (!filename || process.argv.length !== 3) throw new Error('用法：node --env-file=<环境文件> --import tsx scripts/database/import-sqlite.ts <SQLite 文件>');
try { console.log(JSON.stringify(importSqlite(filename, mysqlConfig(process.env)))); }
catch (error) { console.error(error instanceof Error ? error.message : '迁移失败'); process.exitCode = 1; }
