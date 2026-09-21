import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskCenterUI } from '../public/taskCenter.js';

test('conversation creation preserves drafts, prevents duplicate sends and supports retry', async t => {
  t.mock.method(globalThis, 'setInterval', (() => 0) as any);
  const handlers: Record<string, any> = {};
  const control = { disabled: false, focus() {}, scrollTop: 0, scrollHeight: 100 };
  const root = {
    innerHTML: '',
    addEventListener(name: string, handler: any) { handlers[name] = handler; },
    querySelector(selector: string) {
      if (selector === 'dialog[open]') return null;
      return this.innerHTML.includes('id="tc-create-form"') ? control : null;
    }
  };
  let fail = true, writes = 0;
  const bodies: any[] = [];
  const ui = createTaskCenterUI({ root, canEdit: () => true, toast() {}, api: async (_url: string, options?: any) => {
    if (!options) return { tasks: [], sessions: [], devices: [], handoffs: [], executions: [] };
    writes++; bodies.push(JSON.parse(options.body));
    if (fail) throw new Error('暂时无法创建');
    return { taskId: 'created-task' };
  } });
  const click = (action: string, id = '') => handlers.click({ target: { closest: () => ({ dataset: { tc: action, id } }) } });
  const submit = () => handlers.submit({ target: { id: 'tc-create-form' }, preventDefault() {} });
  await ui.load(); await click('new');
  assert.match(root.innerHTML, /id="tc-create-form"/);
  assert.doesNotMatch(root.innerHTML, /<dialog|name="title"|name="constraints"/);
  handlers.input({ target: { id: 'tc-create-message', value: '  修复登录\n保留 <完整需求>  ' } });
  await click('page', 'tasks'); await click('new');
  assert.match(root.innerHTML, /修复登录\n保留 &lt;完整需求&gt;/);
  const before = root.innerHTML; await ui.load(); assert.equal(root.innerHTML, before);
  await submit();
  assert.match(root.innerHTML, /暂时无法创建/);
  assert.match(root.innerHTML, /修复登录/);
  fail = false;
  await Promise.all([submit(), submit()]);
  assert.equal(writes, 2);
  assert.deepEqual(bodies[1], { action: 'create', content: '修复登录\n保留 <完整需求>', sessionId: null });
  assert.match(root.innerHTML, /任务已创建/);
  assert.match(root.innerHTML, /data-id="created-task"/);
  assert.doesNotMatch(root.innerHTML, /暂时无法创建/);
  await submit(); assert.equal(writes, 2);
});

test('task timeline reads in place and background polling never replaces the reader', async t => {
  t.mock.method(globalThis, 'setInterval', (() => 0) as any);
  const handlers: Record<string, any> = {};
  const panel = { innerHTML: '' }, notice = { hidden: true };
  const root = { innerHTML: '', addEventListener(name: string, handler: any) { handlers[name] = handler; }, querySelector(selector: string) { if (selector === '#tc-updates') return notice; if (selector.startsWith('[data-session-body=')) return panel; return null; } };
  const snapshot: any = { tasks: [{ id: 'task', title: '修复登录', status: 'review', context: { goal: '目标' }, contextVersion: 1, revision: 1, sessionIds: ['session'], events: [], updatedAt: '2026-09-18T10:00:00Z' }], sessions: [{ id: 'session', nativeId: 'thread', title: '定位故障', deviceId: 'local', agent: 'codex', updatedAt: '2026-09-18T10:00:00Z' }], devices: [{ id: 'local', name: 'Mac', agents: ['codex'], online: true }], handoffs: [], executions: [{ id: 'completed', taskId: 'task', deviceId: 'local', agent: 'codex', sessionId: 'thread', status: 'completed', output: '不应重复显示的执行回复', createdAt: '2026-09-18T10:00:00Z' }] };
  let reads = 0;
  const ui = createTaskCenterUI({ root, canEdit: () => true, toast() {}, api: async (url: string) => {
    if (url.startsWith('/api/agent-sessions/')) { reads++; return { messages: [{ role: 'assistant', text: reads === 1 ? '**第一段**' : '第二段' }], total: 2, session: {} }; }
    return structuredClone(snapshot);
  } });
  const click = (tc: string, id = '') => handlers.click({ target: { closest: () => ({ dataset: { tc, id }, disabled: false }) } });
  await ui.load();
  assert.match(root.innerHTML, /任务时间线/);
  assert.match(root.innerHTML, /待验收/);
  assert.doesNotMatch(root.innerHTML, /本轮已完成|执行详情|不应重复显示的执行回复/);
  await click('read-session', 'session');
  assert.match(panel.innerHTML, /<strong>第一段<\/strong>/);
  await click('more-session', 'session');
  assert.match(panel.innerHTML, /第一段/); assert.match(panel.innerHTML, /第二段/);
  const before = root.innerHTML;
  snapshot.tasks[0].context.next = '新增下一步';
  await ui.load({ quiet: true });
  assert.equal(root.innerHTML, before);
  assert.equal(notice.hidden, false);
});
