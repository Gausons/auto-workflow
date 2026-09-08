import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/database.mjs';

const tokenA = 'a'.repeat(43), tokenB = 'b'.repeat(43);
const snapshot = (title) => ({ bugs: [{ id: 'same-bug', title }], runs: [{ id: 'same-run', status: 'ready' }], executionRecords: [] });

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
    assert.equal(db.authenticate(tokenA).id, 'a');
    assert.equal(db.authenticate('unknown'), null);
    db.rotateToken('a', 'c'.repeat(43));
    assert.equal(db.authenticate(tokenA), null);
    assert.equal(db.authenticate('c'.repeat(43)).id, 'a');
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
