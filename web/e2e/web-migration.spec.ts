import { expect, test } from '@playwright/test';

const token = 'test-only-token-for-web-e2e-2026-long-enough';
const password = 'Test-Web-E2E-Password-2026';

test.beforeAll(async ({ request }) => {
  const setup = await request.post('/api/auth/setup', { headers: { Authorization: `Bearer ${token}` }, data: { username: 'owner', displayName: 'E2E 所有者', password } });
  expect(setup.ok() || setup.status() === 409).toBeTruthy();
});

async function login(page: import('@playwright/test').Page) {
  await page.goto('/tasks');
  await page.getByRole('textbox', { name: '用户名', exact: true }).fill('owner');
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '任务中心', exact: true })).toBeVisible();
}

test('login, normal URLs, old hash links and deep refresh', async ({ page }) => {
  await login(page);
  await page.getByRole('link', { name: '新建任务', exact: true }).click();
  await expect(page).toHaveURL(/\/tasks\/new$/);
  await expect(page.getByRole('textbox', { name: '任务描述' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: '新建任务', exact: true })).toBeVisible();
  await page.getByRole('link', { name: '返回任务中心' }).click();
  await expect(page).toHaveURL(/\/tasks$/);
  await page.goto('/#workbench');
  await expect(page).toHaveURL(/\/workbench$/);
  await expect(page.getByRole('heading', { name: '缺陷工作台', exact: true })).toBeVisible();
  await page.getByRole('link', { name: '设置', exact: true }).click();
  await page.getByRole('link', { name: /我的账号/ }).click();
  await expect(page).toHaveURL(/\/settings\/account$/);
  await expect(page.getByText('owner · E2E 所有者')).toBeVisible();
});

test('creates one task without silently starting an unavailable Agent', async ({ page }) => {
  await login(page);
  await page.getByRole('link', { name: '新建任务', exact: true }).click();
  const writes: string[] = [];
  page.on('request', request => { if (request.url().endsWith('/api/task-center') && request.method() === 'POST') writes.push(request.postData() || ''); });
  await page.getByRole('textbox', { name: '任务描述' }).fill('浏览器回归测试任务');
  await page.getByRole('button', { name: '创建并发送任务' }).click();
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(page.getByRole('heading', { name: '浏览器回归测试任务' })).toBeVisible();
  expect(writes).toHaveLength(1);
  expect(JSON.parse(writes[0]!)).toMatchObject({ action: 'create', content: '浏览器回归测试任务' });
});

test('viewer cannot create or execute tasks', async ({ page, request }) => {
  const owner = await request.post('/api/auth/login', { data: { tenantId: 'default', username: 'owner', password } });
  const { token: ownerToken } = await owner.json() as { token: string };
  const created = await request.post('/api/organization/members', { headers: { Authorization: `Bearer ${ownerToken}` }, data: { username: 'viewer', displayName: '只读测试', role: 'viewer', password } });
  expect(created.ok()).toBeTruthy();
  await page.goto('/tasks');
  await page.getByRole('textbox', { name: '用户名', exact: true }).fill('viewer');
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '任务中心', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '继续任务' })).toHaveCount(0);
  await page.goto('/tasks/new');
  await expect(page.getByText('当前账号没有创建任务权限。')).toBeVisible();
  await expect(page.getByRole('button', { name: '创建并发送任务' })).toBeDisabled();
});

test('history continuation keeps the same requestId after an uncertain response', async ({ page }) => {
  const id = 'a'.repeat(64);
  const session = { id, sessionId: id, agent: 'codex', agentLabel: 'Codex', deviceId: 'local', title: '回归会话', cwd: '/repo', status: 'ready', createdAt: '2026-09-27T00:00:00Z', updatedAt: '2026-09-27T00:01:00Z', messageCount: 0 };
  const writes: Array<{ message: string; requestId: string }> = [];
  await page.route('**/api/agent-sessions?*', route => route.fulfill({ json: { offset: 0, limit: 30, total: 1, scope: 'workspace', providers: [{ id: 'codex', label: 'Codex', status: 'available' }], workspaces: [], sessions: [session] } }));
  await page.route(`**/api/agent-sessions/${id}?*`, route => route.fulfill({ json: { session, messages: [], total: 0 } }));
  await page.route(`**/api/agent-sessions/${id}/continue`, route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { execution: null, executions: [] } });
    writes.push(JSON.parse(route.request().postData() || '{}'));
    return writes.length === 1 ? route.fulfill({ status: 503, json: { message: '暂时无法确认提交结果' } }) : route.fulfill({ json: { executionId: 'job-1' } });
  });
  await login(page);
  await page.getByRole('link', { name: 'Agent 历史会话' }).click();
  await page.getByRole('button', { name: /回归会话/ }).click();
  await page.getByRole('textbox', { name: '发送消息' }).fill('继续排查');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.getByText(/暂时无法确认提交结果/)).toBeVisible();
  await expect(page.getByRole('textbox', { name: '发送消息' })).toHaveValue('继续排查');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[0]).toMatchObject({ message: '继续排查' });
  expect(writes[1]?.requestId).toBe(writes[0]?.requestId);
});

test('Agent request reply and unknown-result reconciliation never resubmit execution', async ({ page }) => {
  let status: 'waiting' | 'unknown' = 'waiting';
  const controls: Array<Record<string, unknown>> = [];
  const task = { id: 'task-control', title: '执行控制测试', status: 'waiting', revision: 3, contextVersion: 1, content: '处理待办', sessionIds: [], events: [], createdAt: '2026-09-27T00:00:00Z', updatedAt: '2026-09-27T00:00:00Z' };
  await page.route('**/api/task-center', route => route.fulfill({ json: { tasks: [task], sessions: [], devices: [], handoffs: [], executions: [{ id: 'job-control', taskId: task.id, status, contextVersion: 1, deviceId: 'local', cwd: '/repo', title: task.title, prompt: '处理待办', createdAt: '2026-09-27T00:00:00Z', updatedAt: '2026-09-27T00:00:00Z', message: status === 'unknown' ? '结果不确定' : '', request: status === 'waiting' ? { method: 'item/tool/requestUserInput', params: { questions: [{ id: 'q1', question: '是否继续？' }] } } : null }] } }));
  await page.route('**/api/task-center/execution-action', route => { controls.push(JSON.parse(route.request().postData() || '{}')); if (controls[0]?.action === 'respond') status = 'unknown'; return route.fulfill({ json: {} }); });
  const executeWrites: string[] = [];
  page.on('request', request => { if (request.url().endsWith('/api/task-center/execute') && request.method() === 'POST') executeWrites.push(request.postData() || ''); });
  await login(page);
  await page.getByRole('button', { name: '处理待办' }).click();
  await page.getByRole('textbox', { name: '是否继续？' }).fill('继续');
  await page.getByRole('button', { name: '发送回复' }).click();
  await expect.poll(() => controls.length).toBe(1);
  expect(controls[0]).toMatchObject({ executionId: 'job-control', action: 'respond', answers: { q1: '继续' } });
  await page.getByRole('button', { name: '核对执行结果' }).click();
  await expect.poll(() => controls.length).toBe(2);
  expect(controls[1]).toMatchObject({ executionId: 'job-control', action: 'reconcile' });
  expect(executeWrites).toHaveLength(0);
});
