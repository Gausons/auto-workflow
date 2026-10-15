import test from 'node:test';
import assert from 'node:assert/strict';
import { historyTurnPage } from '../shared/historyTurns.js';
import { paginateHistoryTurns } from '../src/historyPagination.js';

test('pages backwards by ten questions without cutting tools, progress or long replies', () => {
  const messages = Array.from({ length: 23 }, (_, turn) => [
    { role: 'user', text: `问题 ${turn}` },
    ...Array.from({ length: 40 }, (_, index) => ({ role: index % 2 ? 'tool_result' : 'tool_call', text: `工具 ${turn}:${index}` })),
    { role: 'assistant', text: `回复 ${turn}` + '长内容'.repeat(10000) }
  ]).flat();
  const latest = paginateHistoryTurns(messages, new URLSearchParams({ turns: '10' }));
  assert.equal(latest.messages[0].text, '问题 13');
  assert.deepEqual(latest.messages, messages.slice(13 * 42));
  assert.deepEqual(latest.turnPage, { total: 23, count: 10, before: 13 * 42 });
  const older = historyTurnPage(messages, latest.turnPage.before!, 10);
  assert.equal(older.messages[0].text, '问题 3');
  assert.deepEqual(older.messages, messages.slice(3 * 42, 13 * 42));
  const first = historyTurnPage(messages, older.turnPage.before!, 10);
  assert.equal(first.turnPage.count, 3);
  assert.equal(first.turnPage.before, null);
  assert.deepEqual([...first.messages, ...older.messages, ...latest.messages], messages);
});

test('keeps unfinished turns, orphan legacy records and empty sessions visible', () => {
  const messages = [{ role: 'assistant', text: '旧片段' }, { role: 'user', text: '正在处理的问题' }, { role: 'tool_call', text: '执行中' }];
  assert.deepEqual(historyTurnPage(messages).messages, messages);
  assert.equal(historyTurnPage([]).turnPage.count, 0);
  assert.equal(historyTurnPage([]).turnPage.before, null);
});

test('rejects invalid turn pagination instead of falling back to a different range', () => {
  for (const query of ['turns=0', 'turns=11', 'turns=NaN', 'turns=1&before=-1', 'turns=1&before=2', 'turns=1&before=']) {
    assert.throws(() => paginateHistoryTurns([{ role: 'user' }], new URLSearchParams(query)), { statusCode: 400 });
  }
});
