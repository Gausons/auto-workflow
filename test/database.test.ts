import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/database.js';
import { freezeSnapshot } from '@auto-workflow/context-engine';
import { DatabaseSync } from 'node:sqlite';

const tokenA = 'a'.repeat(43), tokenB = 'b'.repeat(43);
const snapshot = (title: string) => ({ bugs: [{ id: 'same-bug', title }] });

test('SQLite isolates identical user and entity IDs by tenant, rolls back failed snapshots and survives reopen', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bugflow-db-'));
  const filename = path.join(root, 'workflow.sqlite');
  let db = openDatabase(filename);
  try {
    db.createTenant({ id: 'a', token: tokenA });
    db.createTenant({ id: 'b', token: tokenB });
    const a = db.createStore('a'), b = db.createStore('b');
    await Promise.all([a.writeUserState('same-person', snapshot('A')), b.writeUserState('same-person', snapshot('B'))]);
    a.scheduleSave('other-person', snapshot('other'));
    assert.equal(a.readUserState('same-person').bugs[0].title, 'A');
    assert.equal(b.readUserState('same-person').bugs[0].title, 'B');
    assert.equal(a.readUserState('other-person').bugs[0].title, 'other');
    assert.equal(db.authenticate(tokenA)!.id, 'a');
    assert.equal(db.authenticate('unknown'), null);
    db.rotateToken('a', 'c'.repeat(43));
    assert.equal(db.authenticate(tokenA), null);
    assert.equal(db.authenticate('c'.repeat(43))!.id, 'a');
    await assert.rejects(a.writeUserState('same-person', { ...snapshot('bad'), bugs: [{ id: 'duplicate' }, { id: 'duplicate' }] }));
    assert.equal(a.readUserState('same-person').bugs[0].title, 'A');
    db.close();
    db = openDatabase(filename);
    assert.equal(db.createStore('b').readUserState('same-person').bugs[0].title, 'B');
    assert.equal(db.createStore('a').readUserState('other-person').bugs[0].title, 'other');
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});

test('legacy import supports the old doubled users directory, is atomic and does not repeat', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bugflow-migrate-'));
  const db = openDatabase(':memory:');
  try {
    db.createTenant({ id: 'default', token: tokenA });
    const dir = path.join(root, '.workflow-data/users/users/person');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'state.json'), JSON.stringify(snapshot('legacy')));
    await writeFile(path.join(root, '.workflow-config.json'), JSON.stringify({ assignee: 'person' }));
    await writeFile(path.join(root, '.assignment-people.json'), JSON.stringify({ people: [{ name: 'A' }] }));
    assert.deepEqual(db.importLegacy(root, 'default'), { skipped: false, users: 1 });
    assert.equal(db.readSettings('default').config.assignee, 'person');
    assert.equal(db.createStore('default').readUserState('person').bugs[0].title, 'legacy');
    await db.createStore('default').writeUserState('person', snapshot('new'));
    assert.equal(db.importLegacy(root, 'default').skipped, true);
    assert.equal(db.createStore('default').readUserState('person').bugs[0].title, 'new');
    db.createTenant({ id: 'other', token: tokenB });
    assert.equal(db.createStore('other').readUserState('person').bugs.length, 0);
    await writeFile(path.join(dir, 'state.json'), '{malformed');
    assert.throws(() => db.importLegacy(root, 'other'));
    assert.deepEqual(db.readSettings('other').config, {});
    await writeFile(path.join(dir, 'state.json'), JSON.stringify(snapshot('fixed')));
    assert.equal(db.importLegacy(root, 'other').users, 1);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});

test('transfer receipt survives reopen, stays tenant-scoped and cannot change a sealed digest', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'context-receipt-'));
  const filename = path.join(root, 'workflow.sqlite');
  let db = openDatabase(filename);
  try {
    db.createTenant({ id: 'a', token: tokenA }); db.createTenant({ id: 'b', token: tokenB });
    const context = freezeSnapshot([{ role: 'user', text: '保留证据', source: 's' }], ['s']);
    db.recordContextTransferFailure('a', 'execution', 'device-a', 'device-b', context.id, context.digest, '来源暂时不可用');
    assert.equal(db.readContextTransfer('a', 'execution')?.status, 'failed');
    const bundle = db.recordContextTransfer('a', 'execution', 'device-a', 'device-b', context);
    assert.equal(db.readContextTransfer('a', 'execution')?.revision, 2);
    assert.equal(db.readContextTransfer('b', 'execution'), undefined);
    db.close(); db = openDatabase(filename);
    assert.equal(db.readContextTransfer('a', 'execution')?.manifestDigest, bundle.manifestDigest);
    assert.equal(db.recordContextTransfer('a', 'execution', 'device-a', 'device-b', context).manifestDigest, bundle.manifestDigest);
    const changed = freezeSnapshot([{ role: 'user', text: '不同内容', source: 's' }], ['s']);
    assert.throws(() => db.recordContextTransfer('a', 'execution', 'device-a', 'device-b', changed), /不能覆盖/);
    assert.throws(() => db.recordContextTransfer('a', 'execution', 'device-a', 'device-b', changed, 'new-context-key'), /不能覆盖/);
    assert.equal(db.readSessionContext('a', 'new-context-key'), null);
    assert.throws(() => db.recordContextTransfer('a', 'execution', 'device-a', 'device-c', context), /不能覆盖/);
    assert.equal(db.readContextTransfer('a', 'execution')?.revision, 2);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});

test('migration 006 upgrades an existing v5 database without changing its session snapshots', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'context-upgrade-'));
  const filename = path.join(root, 'workflow.sqlite');
  try {
    const first = openDatabase(filename);
    first.createTenant({ id: 'a', token: tokenA });
    const context = freezeSnapshot([{ role: 'user', text: '升级前记录', source: 's' }], ['s']);
    first.saveSessionContext('a', context);
    first.close();
    const old = new DatabaseSync(filename);
    old.exec('DROP TABLE context_transfers; PRAGMA user_version = 5;');
    old.close();
    const upgraded = openDatabase(filename);
    try {
      assert.deepEqual(upgraded.readSessionContext('a', context.id), context);
      assert.equal(upgraded.readContextTransfer('a', 'missing'), undefined);
      const check = new DatabaseSync(filename);
      try { assert.equal(check.prepare('PRAGMA user_version').get()?.user_version, 6); }
      finally { check.close(); }
    } finally { upgraded.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
