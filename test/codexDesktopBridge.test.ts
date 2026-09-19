import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDesktopTerminal } from '../src/codexDesktopBridge.js';

test('foreign turn requires its own explicit completion event, ignoring partial writes and other turns', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-terminal-')), file = join(dir, 'rollout.jsonl');
  const line = (type: string, id: string, extra = {}) => JSON.stringify({ type: 'event_msg', payload: { type, turn_id: id, ...extra } }) + '\n';
  try {
    await writeFile(file, line('task_started', 'ours') + line('task_complete', 'other', { last_agent_message: 'wrong' }) + '{"partial":');
    assert.equal(await readDesktopTerminal(file, 'ours'), null);
    await writeFile(file, line('task_complete', 'ours', { last_agent_message: 'correct' }));
    assert.deepEqual(await readDesktopTerminal(file, 'ours'), { status: 'completed', text: 'correct' });
    await writeFile(file, line('turn_aborted', 'ours'));
    assert.deepEqual(await readDesktopTerminal(file, 'ours'), { status: 'interrupted' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
