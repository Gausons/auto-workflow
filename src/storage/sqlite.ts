import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Connection } from './connection.js';

export function openSqlite(filename: string): Connection {
  if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  const version = Number(db.prepare('PRAGMA user_version').get()?.user_version || 0);
  if (version > 8) { db.close(); throw new Error('数据库版本高于当前程序支持的版本'); }
  if (version === 0) {
    sqliteTransaction(() => {
      db.exec(readFileSync(new URL('../../migrations/001_initial.sql', import.meta.url), 'utf8'));
      db.exec('PRAGMA user_version = 1');
    });
  }
  if (version < 2) {
    sqliteTransaction(() => {
      db.exec(readFileSync(new URL('../../migrations/002_rbac.sql', import.meta.url), 'utf8'));
      db.exec('PRAGMA user_version = 2');
    });
  }

  if (version < 3) {
    sqliteTransaction(() => {
      db.exec(readFileSync(new URL('../../migrations/003_task_center.sql', import.meta.url), 'utf8'));
      db.exec('PRAGMA user_version = 3');
    });
  }
  if (version < 4) {
    sqliteTransaction(() => {
      db.exec(readFileSync(new URL('../../migrations/004_remove_workflows.sql', import.meta.url), 'utf8'));
      db.exec('PRAGMA user_version = 4');
    });
  }

  if (version < 5) {
    sqliteTransaction(() => {
      db.exec(readFileSync(new URL('../../migrations/005_session_context.sql', import.meta.url), 'utf8'));
      db.exec('PRAGMA user_version = 5');
    });
  }
  if (version < 6) {
    sqliteTransaction(() => {
      db.exec(readFileSync(new URL('../../migrations/006_context_transfers.sql', import.meta.url), 'utf8'));
      db.exec('PRAGMA user_version = 6');
    });
  }
  if (version < 7) {
    sqliteTransaction(() => {
      db.exec(readFileSync(new URL('../../migrations/007_context_objects.sql', import.meta.url), 'utf8'));
      db.exec('PRAGMA user_version = 7');
    });
  }
  if (version < 8) {
    sqliteTransaction(() => {
      db.exec(readFileSync(new URL('../../migrations/008_external_identities.sql', import.meta.url), 'utf8'));
      db.exec('PRAGMA user_version = 8');
    });
  }

  return db;
  function sqliteTransaction(fn: () => void) {
    db.exec('BEGIN IMMEDIATE');
    try { fn(); db.exec('COMMIT'); }
    catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
  }
}
