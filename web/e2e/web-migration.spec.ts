import { expect, test } from '@playwright/test';

const password = 'Test-Web-E2E-Password-2026';

test.beforeAll(async ({ request }) => {
  const registration = await request.post('/api/auth/register', { data: { username: 'owner', displayName: 'E2E 用户', password } });
  expect(registration.ok() || registration.status() === 409).toBeTruthy();
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
  await expect(page.getByText('owner · E2E 用户')).toBeVisible();
});

test('remote branch selector reads and creates branches through the connector queue', async ({ page }) => {
  let current = 'main';
  await page.route('**/api/task-center/codex', route => route.fulfill({ json: { projects: [{ id: 'p', deviceId: 'remote', deviceName: '开发机', name: 'Codex', cwd: '/repo', online: true, gitBranches: true }] } }));
  await page.route('**/api/task-center/git*', route => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      expect(body.deviceId).toBe('remote');
      if (body.action === 'create') current = body.branch;
      return route.fulfill({ json: { id: body.requestId, status: 'pending' } });
    }
    return route.fulfill({ json: { status: 'completed', result: { repository: true, current, changes: 0, branches: ['main', ...(current !== 'main' ? [current] : [])] } } });
  });
  await login(page);
  await page.getByRole('link', { name: '新建任务', exact: true }).click();
  await expect(page.getByLabel('Git 分支')).toContainText('main');
  await page.getByLabel('Git 分支').click();
  await page.getByLabel('新分支名称').fill('feature/remote');
  await page.getByRole('button', { name: '创建并切换' }).click();
  await expect(page.getByLabel('Git 分支')).toContainText('feature/remote');
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
  const owner = await request.post('/api/auth/login', { data: { username: 'owner', password } });
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

test('device setup selects remote target and browser controls a remote original session', async ({ page, request }) => {
  const loginResult = await request.post('/api/auth/login', { data: { username: 'owner', password } });
  const { token: connectorToken } = await loginResult.json() as { token: string };
  const headers = { Authorization: `Bearer ${connectorToken}` };
  const nativeId = 'c5d32f71-0be1-4507-a9b8-6b843fe29d20';
  const deviceId = 'browser-remote';
  const heartbeat = await request.post('/api/task-center', { headers, data: { action: 'heartbeat', deviceId, name: '浏览器远端开发机', agents: ['codex'], capabilities: { resumeCodex: true }, codexProjects: [{ id: 'remote-project', name: '远端项目', cwd: '/remote/repo', agent: 'codex' }], sessions: [{ nativeId, agent: 'codex', title: '远端续聊回归', cwd: '/remote/repo' }] } });
  expect(heartbeat.ok()).toBeTruthy();
  await login(page);
  await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '设备与 Agent', exact: true }).click();
  await expect(page).toHaveURL(/\/devices$/);
  await expect(page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '设备与 Agent', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.reload();
  await expect(page.getByRole('heading', { name: '连接本机 Agent' })).toBeVisible();
  await expect(page.getByLabel('设备连接配置')).toContainText("WORKBENCH_USERNAME='owner'");
  expect(await page.getByLabel('设备连接配置').inputValue()).not.toContain(connectorToken);
  const device = page.locator('article').filter({ has: page.getByRole('heading', { name: '浏览器远端开发机' }) });
  await expect(device).toContainText('支持 Codex 原会话续聊');
  await device.getByRole('link', { name: '新建远端任务' }).click();
  await expect(page).toHaveURL(/deviceId=browser-remote/);
  await expect(page.getByRole('combobox', { name: '执行位置' })).toHaveValue('0');
  await expect(page.getByRole('combobox', { name: '执行位置' })).toContainText('远端项目');
  const list = await request.get('/api/agent-sessions', { headers });
  const { sessions } = await list.json() as { sessions: Array<{ id: string; deviceId: string }> };
  const session = sessions.find(item => item.deviceId === deviceId)!;
  await page.goto(`/history/${session.id}`);
  await page.getByRole('textbox', { name: '发送消息' }).fill('继续远端测试');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByText(/已排队，准备继续原会话/)).toBeVisible();
  const status = await request.get(`/api/agent-sessions/${session.id}/continue`, { headers });
  const { execution } = await status.json() as { execution: { id: string; resumeThreadId: string; deviceId: string } };
  expect(execution.resumeThreadId).toBe(nativeId); expect(execution.deviceId).toBe(deviceId);
  expect((await request.post('/api/task-center/execution-action', { headers, data: { action: 'claim', executionId: execution.id } })).ok()).toBeTruthy();
  const report = { threadId: nativeId, status: 'waiting', request: { method: 'item/commandExecution/requestApproval', params: { command: 'echo fixture' } }, output: '受控远端输出' };
  expect((await request.post('/api/task-center/execution-action', { headers, data: { action: 'report', executionId: execution.id, report } })).ok()).toBeTruthy();
  await page.getByRole('button', { name: '处理请求' }).click();
  await page.getByRole('button', { name: '发送回复', exact: true }).click();
  await expect(page.getByText(/等待目标设备处理操作/)).toBeVisible();
  const pending = await request.get(`/api/agent-sessions/${session.id}/continue`, { headers });
  const current = await pending.json() as { execution: { control: { id: string; action: string; decision: string } } };
  expect(current.execution.control).toMatchObject({ action: 'respond', decision: 'decline' });
  await request.post('/api/task-center/execution-action', { headers, data: { action: 'report', executionId: execution.id, controlAck: current.execution.control.id, report: { ...report, request: null, status: 'running' } } });
  await page.getByRole('button', { name: '停止', exact: true }).click();
  const stopped = await request.get(`/api/agent-sessions/${session.id}/continue`, { headers });
  const stop = await stopped.json() as { execution: { control: { id: string; action: string } } };
  expect(stop.execution.control.action).toBe('stop');
  await request.post('/api/task-center/execution-action', { headers, data: { action: 'report', executionId: execution.id, controlAck: stop.execution.control.id, report: { ...report, request: null, status: 'interrupted' } } });
  await expect(page.getByRole('button', { name: '重新编辑本轮消息' })).toBeVisible();
});

test('workbench reading layout handles long sync messages, filtering and narrow screens', async ({ page }) => {
  await login(page);
  await page.route('**/api/bootstrap', async route => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({ json: { ...data,
      bugs: [
        { id: 'BUG-1', title: '报表页面加载失败，需要检查数据请求', status: '待处理', priority: '高', assignee: '测试人员', updatedAt: '1790155034256', description: '<p>打开报表后出现空白页面。</p><p><strong>复现步骤</strong></p><ol><li>进入工作台</li><li>打开报表</li></ol>' },
        { id: 'BUG-2', title: '导出结果缺少字段', status: '待处理', priority: '中' }
      ], metrics: { total: 2, pending: 2, processing: 0, resolved: 0 },
      scheduler: { lastRunMessage: `同步失败：${'连接超时，请检查数据源设置。'.repeat(30)}` }
    } });
  });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.getByRole('link', { name: '缺陷工作台', exact: true }).click();
  await expect(page.getByRole('heading', { name: '报表页面加载失败，需要检查数据请求' })).toBeVisible();
  const heading = page.getByRole('heading', { name: '个人缺陷', exact: true });
  expect((await heading.boundingBox())!.height).toBeLessThan(30);
  const list = page.locator('.bug-list-panel');
  const detail = page.locator('.bug-detail-panel');
  expect((await detail.boundingBox())!.x).toBeGreaterThan((await list.boundingBox())!.x + (await list.boundingBox())!.width);
  await page.locator('summary').filter({ hasText: '同步信息' }).click();
  await expect(page.getByText(/^同步失败：/)).toBeVisible();
  await page.locator('summary').filter({ hasText: '同步信息' }).click();
  await page.screenshot({ path: 'test-results/workbench-desktop.png', fullPage: true });
  await page.getByRole('searchbox', { name: '搜索缺陷' }).fill('BUG-2');
  await expect(page.getByRole('heading', { name: '导出结果缺少字段' })).toBeVisible();
  await page.getByRole('searchbox', { name: '搜索缺陷' }).clear();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(heading).toBeVisible();
  expect((await detail.boundingBox())!.y).toBeGreaterThan((await list.boundingBox())!.y);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.screenshot({ path: 'test-results/workbench-mobile.png', fullPage: true });
});
