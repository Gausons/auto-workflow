import { expect, test } from '@playwright/test';

for (const agent of ['codex', 'claude']) test(`authentication identifies the actual ${agent} engine and preserves unknown outcomes without resubmission`, async ({ page, request }, testInfo) => {
  const label = agent === 'codex' ? 'Codex' : 'Claude Code';
  const response = await request.post('/api/auth/register', { data: { username: `auth-error-${Date.now()}`, password: 'Authentication-E2E-Test-2026' } });
  expect(response.status()).toBe(201);
  const { token } = await response.json() as { token: string };
  const headers = { Authorization: `Bearer ${token}` };
  expect((await request.post('/api/task-center', { headers, data: { action: 'heartbeat', deviceId: 'auth-device', name: '认证测试开发机', agents: [agent], codexProjects: [{ id: 'auth-project', name: label, agent, cwd: '/fixture/repo', protocol: 'acp' }], sessions: [] } })).ok()).toBeTruthy();
  const created = await request.post('/api/task-center', { headers, data: { action: 'create', title: 'Agent 认证错误回归' } });
  const { taskId } = await created.json() as { taskId: string };
  const started = await request.post('/api/task-center/execute', { headers, data: { taskId, revision: 1, deviceId: 'auth-device', projectId: 'auth-project' } });
  expect(started.ok()).toBeTruthy();
  const { executionId } = await started.json() as { executionId: string };
  expect((await request.post('/api/task-center/execution-action', { headers, data: { action: 'claim', executionId } })).ok()).toBeTruthy();
  expect((await request.post('/api/task-center/execution-action', { headers, data: { action: 'report', executionId, report: { status: 'unknown', message: 'Authentication required', agentLabel: agent === 'claude' ? 'Agent 1' : label } } })).ok()).toBeTruthy();
  let writes = 0;
  page.on('request', req => { if (req.method() === 'POST' && req.url().includes('/api/task-center')) writes++; });
  await page.goto('/tasks'); await page.evaluate(value => sessionStorage.setItem('bugflow.sessionToken', value), token); await page.reload();
  await expect(page.getByRole('heading', { name: 'Agent 认证错误回归', exact: true })).toBeVisible();
  await expect(page.getByText(new RegExp(`目标设备上的 ${label} 需要认证`))).toBeVisible();
  await page.getByText('执行详情', { exact: true }).click();
  await expect(page.getByText(new RegExp(`${agent === 'claude' ? 'Agent 1（Claude Code）' : label} · ACP`))).toBeVisible();
  await expect(page.getByRole('button', { name: '核对执行结果', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '继续任务', exact: true })).toHaveCount(0);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1100 });
    if (width === 390) await page.getByRole('button', { name: /^Agent 认证错误回归/ }).click();
    await expect(page.getByText(new RegExp(`目标设备上的 ${label} 需要认证`))).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await page.screenshot({ path: testInfo.outputPath(`agent-authentication-${width}.png`), fullPage: true });
  }
  expect(writes).toBe(0);
  const snapshot = await request.get('/api/task-center', { headers });
  const { executions } = await snapshot.json() as { executions: { id: string; status: string }[] };
  expect(executions).toHaveLength(1); expect(executions[0].status).toBe('unknown');
});
