import { expect, test } from '@playwright/test';
import type { Execution } from '../../shared/taskTypes.js';

test('two devices implement separate parts of a task and exchange a reviewed document', async ({ page, request }, testInfo) => {
  test.setTimeout(60_000);
  const account = await request.post('/api/auth/register', {
    data: { username: `split-source-${Date.now()}`, password: 'Split-Source-Workspace-2026' }
  });
  expect(account.status()).toBe(201);
  const personal = await account.json() as { token: string };
  const auth = { Authorization: `Bearer ${personal.token}` };
  const team = await request.post('/api/workspaces', { headers: auth, data: { name: '跨设备研发', requestId: crypto.randomUUID() } });
  const { id } = await team.json() as { id: string };
  const session = await request.post('/api/workspaces/switch', { headers: auth, data: { tenantId: id } });
  const { token } = await session.json() as { token: string };
  const headers = { Authorization: `Bearer ${token}` };
  const submit = async (url: string, data: object) => {
    const response = await request.post(url, { headers, data });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response;
  };
  const devices = [
    { deviceId: 'orders-api', agent: 'codex', name: '服务端', responsibility: '实现订单查询接口', cwd: '/api/orders' },
    { deviceId: 'orders-web', agent: 'claude', name: '前端', responsibility: '实现订单列表页面', cwd: '/web/store' }
  ];
  for (const d of devices) await submit('/api/task-center', {
    action: 'heartbeat', deviceId: d.deviceId, name: d.name, agents: [d.agent], capabilities: { collaborationSessions: true }, sessions: [],
    codexProjects: [{ id: 'source', name: d.name, agent: d.agent, cwd: d.cwd, protocol: 'acp' }]
  });
  await page.goto('/space');
  await page.evaluate(value => sessionStorage.setItem('bugflow.sessionToken', value), token);
  await page.reload();
  await page.getByRole('button', { name: '协作任务', exact: true }).click();
  await page.getByRole('button', { name: '新建协作任务', exact: true }).click();
  await page.getByLabel('任务名称').fill('打通订单列表');
  await page.getByLabel('共同目标').fill('让客户可以查看自己的订单。');
  for (const [index, d] of devices.entries()) {
    const group = page.getByRole('group', { name: `分工 ${index + 1}`, exact: true });
    await group.getByLabel('分工名称').fill(d.name);
    await group.getByLabel('执行目标').selectOption(JSON.stringify([d.deviceId, 'source']));
    await group.getByLabel('职责').fill(d.responsibility);
    await expect(group.getByText(d.cwd)).toBeVisible();
  }
  await page.getByRole('button', { name: '创建协作任务', exact: true }).click();
  await expect(page.getByRole('heading', { name: '打通订单列表' })).toBeVisible();
  const card = (i: number) => page.getByRole('article', { name: devices[i].name, exact: true });
  const start = async (index: number, doc?: string) => {
    await card(index).getByRole('button', { name: '启动分工' }).click();
    if (doc) await card(index).getByRole('checkbox', { name: doc }).check();
    const sent = page.waitForResponse(r => r.url().endsWith('/runs') && r.request().method() === 'POST');
    await card(index).getByRole('button', { name: '确认启动' }).click();
    const result = await sent;
    expect(result.status()).toBe(202);
    const { executionId } = await result.json() as { executionId: string };
    const response = await submit('/api/task-center/execution-action', { action: 'claim', executionId });
    const { job } = await response.json() as { job: Execution };
    expect([job.deviceId, job.agent, job.cwd]).toEqual([devices[index].deviceId, devices[index].agent, devices[index].cwd]);
    return job;
  };
  const first = await start(0);
  const privateNote = '本轮仅用于服务端内部验证的记录';
  await submit('/api/task-center/execution-action', {
    action: 'report', executionId: first.id, report: { status: 'completed', sessionId: 'api-fixture', output: privateNote }
  });
  await card(0).getByText('第 1 轮 · 本轮已完成').click();
  await card(0).getByRole('button', { name: '整理为交接文档' }).click();
  await expect(page.getByLabel('文档正文')).toHaveValue(privateNote);
  await page.getByLabel('文档标题').fill('订单接口约定');
  const body = 'GET /orders 返回 items 数组，空结果为 []。';
  await page.getByLabel('文档正文').fill(body);
  await page.getByRole('button', { name: '发布文档' }).click();
  await expect(page.getByText('交接文档已发布。')).toBeVisible();
  const second = await start(1, '订单接口约定');
  expect(second.prompt).toContain(body);
  expect(second.prompt).not.toContain(privateNote);
  await submit('/api/task-center/execution-action', {
    action: 'report', executionId: second.id, report: { status: 'completed', sessionId: 'web-fixture', output: '已接入订单列表。' }
  });
  await expect(card(1).getByText('第 1 轮 · 本轮已完成')).toBeVisible();
  await page.getByText('订单接口约定', { exact: true }).click();
  await expect(page.getByText(body, { exact: true })).toBeVisible();
  await expect(page.getByLabel('完成通知').getByRole('button', { name: /关闭完成通知/ })).toHaveCount(0);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await page.screenshot({ path: testInfo.outputPath(`collaboration-${width}.png`), fullPage: true });
  }
  await card(1).getByRole('button', { name: '查看执行' }).click();
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(page.getByRole('heading', { name: '打通订单列表 · 前端', exact: true })).toBeVisible();
  await page.getByRole('link', { name: '查看协作任务' }).click();
  await page.reload();
  await expect(page.getByRole('heading', { name: '打通订单列表', exact: true })).toBeVisible();
  await expect(page.getByText('订单接口约定', { exact: true })).toBeVisible();
});
