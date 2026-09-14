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
  assert.deepEqual(bodies[1], { action: 'create', title: '修复登录', context: { goal: '修复登录\n保留 <完整需求>' }, sessionId: null });
  assert.match(root.innerHTML, /任务已创建/);
  assert.match(root.innerHTML, /data-id="created-task"/);
  assert.doesNotMatch(root.innerHTML, /暂时无法创建/);
  await submit(); assert.equal(writes, 2);
});
