import { expect, test } from '@playwright/test';
import type { GroupChatRoom } from '../../shared/groupChatTypes.js';
import type { Execution } from '../../shared/taskTypes.js';

test('team members create a multi-agent discussion, see ordered replies, and stop the next round', async ({ page, request }, testInfo) => {
  test.setTimeout(60_000);
  const owner = await request.post('/api/auth/register', { data: { username: `group-chat-${Date.now()}`, password: 'Group-Chat-E2E-Password-2026' } });
  expect(owner.status()).toBe(201);
  const account = await owner.json() as { token: string };
  const team = await request.post('/api/workspaces', { headers: { Authorization: `Bearer ${account.token}` }, data: { name: 'Agent 协作团队', requestId: crypto.randomUUID() } });
  const { id: teamId } = await team.json() as { id: string };
  const switched = await request.post('/api/workspaces/switch', { headers: { Authorization: `Bearer ${account.token}` }, data: { tenantId: teamId } });
  const { token } = await switched.json() as { token: string };
  const headers = { Authorization: `Bearer ${token}` };
  const heartbeat = await request.post('/api/task-center', { headers, data: { action: 'heartbeat', deviceId: 'chat-fixture', name: '测试研发设备', agents: ['codex', 'claude'], sessions: [], codexProjects: ['codex', 'claude'].map(agent => ({ id: agent, name: `${agent} 项目`, agent, protocol: 'acp', cwd: '/fixture/repo' })) } });
  expect(heartbeat.ok()).toBeTruthy();
  await page.goto('/space'); await page.evaluate(value => sessionStorage.setItem('bugflow.sessionToken', value), token); await page.reload();
  await page.getByRole('button', { name: '群组聊天室', exact: true }).click();
  await page.getByRole('button', { name: '＋ 新建聊天室' }).click();
  await page.getByLabel('聊天室名称').fill('发布方案评审');
  const participants = page.getByRole('group', { name: /^Agent [12]$/ });
  await participants.nth(0).getByLabel('显示名称').fill('方案设计师');
  await participants.nth(0).getByLabel('执行目标').selectOption(JSON.stringify(['chat-fixture', 'codex']));
  await participants.nth(1).getByLabel('显示名称').fill('安全评审员');
  await participants.nth(1).getByLabel('执行目标').selectOption(JSON.stringify(['chat-fixture', 'claude']));
  await participants.nth(1).getByLabel('讨论职责（可选）').fill('检查权限与隔离');
  await page.getByRole('button', { name: '创建聊天室', exact: true }).click();
  await expect(page.getByRole('heading', { name: '发布方案评审' })).toBeVisible();
  await page.getByLabel('讨论消息').fill('请讨论安全发布方案');
  await page.getByRole('button', { name: '发送并开始讨论' }).click();
  await expect(page.getByLabel('讨论消息')).toBeDisabled();
  const list = await request.get('/api/workspaces/chats', { headers });
  const roomId = (await list.json() as { rooms: { id: string }[] }).rooms[0].id;
  const detail = async () => (await (await request.get(`/api/workspaces/chats/${roomId}`, { headers })).json() as { room: GroupChatRoom }).room;
  for (const [index, output] of ['建议先灰度发布并准备回滚方案。', '同意灰度，发布前补充权限隔离检查。'].entries()) {
    let executionId = '';
    await expect.poll(async () => { executionId = (await detail()).messages[index + 1].executionId || ''; return Boolean(executionId); }).toBe(true);
    const claimed = await request.post('/api/task-center/execution-action', { headers, data: { action: 'claim', executionId } });
    expect(claimed.ok()).toBeTruthy();
    const job = (await claimed.json() as { job: Execution }).job;
    expect(job.agent).toBe(index ? 'claude' : 'codex');
    if (index) expect(job.prompt).toContain('建议先灰度发布并准备回滚方案。');
    const reported = await request.post('/api/task-center/execution-action', { headers, data: { action: 'report', executionId, report: { status: 'completed', output, message: '测试 Agent 回复完成', sessionId: `group-chat-fixture-${index}` } } });
    expect(reported.ok()).toBeTruthy();
    await expect(page.getByText(output, { exact: true })).toBeVisible();
  }
  await expect(page.getByLabel('讨论消息')).toBeEnabled();
  await expect(page.getByLabel('完成通知').getByRole('button', { name: /关闭完成通知/ })).toHaveCount(0);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1100 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await page.screenshot({ path: testInfo.outputPath(`group-chat-${width}.png`), fullPage: true });
  }
  await page.reload(); await page.getByRole('button', { name: '群组聊天室', exact: true }).click();
  await expect(page.getByText('同意灰度，发布前补充权限隔离检查。', { exact: true })).toBeVisible();
  await page.getByLabel('讨论消息').fill('继续讨论回滚'); await page.getByRole('button', { name: '发送并开始讨论' }).click();
  await expect.poll(() => page.getByRole('log', { name: '讨论记录' }).evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  const stopped = page.waitForResponse(response => response.url().endsWith(`/api/workspaces/chats/${roomId}/stop`) && response.request().method() === 'POST');
  await page.getByRole('button', { name: '停止讨论', exact: true }).click();
  const stopResponse = await stopped;
  expect(stopResponse.ok(), await stopResponse.text()).toBeTruthy();
  await expect(page.getByLabel('讨论消息')).toBeEnabled();
  await expect.poll(async () => (await detail()).round?.status).toBe('stopped');
  await page.getByRole('button', { name: '查看执行' }).first().click();
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(page.getByRole('heading', { name: '发布方案评审 · 方案设计师', exact: true, level: 2 })).toBeVisible();
});
