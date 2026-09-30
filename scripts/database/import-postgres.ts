import { importMysqlToPostgres } from '../../src/storage/import-postgres.js';
import { mysqlConfig } from '../../src/storage/mysql.js';
import { postgresConfig } from '../../src/storage/postgres.js';
try { console.log(JSON.stringify(importMysqlToPostgres(mysqlConfig(process.env), postgresConfig(process.env)))); }
catch (error) { console.error(error instanceof Error ? error.message : '迁移失败'); process.exitCode = 1; }
