import { expect, test } from '@playwright/test';

const password = 'Workspace-E2E-Password-2026';
test('create a team, accept an invitation, share work and return to a private workspace', async ({ page, request, browser }, testInfo) => {
  const suffix = Date.now();
  const ownerName = `collab-owner-${suffix}`, memberName = `collab-member-${suffix}`;
  const register = async (username: string, displayName: string) => {
    const response = await request.post('/api/auth/register', { data: { username, displayName, password } });
    expect(response.status()).toBe(201);
    return await response.json() as { token: string; tenant: { id: string } };
  };
  const owner = await register(ownerName, '陈一'), member = await register(memberName, '林嘉');
  await page.goto('/space');
  await page.evaluate(token => sessionStorage.setItem('bugflow.sessionToken', token), owner.token);
  await page.reload();
  await expect(page.getByRole('heading', { name: '让协作，从这里开始。' })).toBeVisible();
  await page.getByRole('button', { name: '＋ 创建团队空间', exact: true }).click();
  await page.getByLabel('空间名称').fill('产品与研发');
  await page.getByRole('button', { name: '创建并进入' }).click();
  await expect(page.getByRole('heading', { name: '产品与研发' })).toBeVisible();
  await page.getByRole('button', { name: /^成员/ }).click();
  await page.getByLabel('账号用户名').fill(memberName);
  await page.getByRole('button', { name: '邀请成员' }).click();
  await expect(page.getByRole('heading', { name: '待接受邀请' })).toBeVisible();
  const context = await browser.newContext();
  const colleague = await context.newPage();
  try {
    await colleague.goto('/space');
    await colleague.evaluate(token => sessionStorage.setItem('bugflow.sessionToken', token), member.token);
    await colleague.reload();
    await colleague.getByRole('button', { name: '接受邀请' }).click();
    await expect(colleague.getByRole('button', { name: /产品与研发/ })).toBeVisible();
    await colleague.getByRole('button', { name: /产品与研发/ }).click();
    await expect(colleague.getByRole('heading', { name: '产品与研发' })).toBeVisible();
    const teamToken = await page.evaluate(() => sessionStorage.getItem('bugflow.sessionToken'));
    const task = await request.post('/api/task-center', { headers: { Authorization: `Bearer ${teamToken}` }, data: { action: 'create', title: '完善团队协作体验', content: '# 完善团队协作体验\n梳理成员反馈，完善工作空间体验。' } });
    expect(task.ok()).toBeTruthy();
    await page.reload(); await colleague.reload();
    await expect(colleague.getByRole('button', { name: /^完善团队协作体验/ })).toBeVisible();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1050 });
      await expect(page.getByRole('heading', { name: '产品与研发' })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      await page.screenshot({ path: testInfo.outputPath(`team-space-${width}.png`), fullPage: true });
      await page.getByRole('button', { name: /^成员/ }).click();
      await expect(page.getByText('林嘉', { exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      await page.screenshot({ path: testInfo.outputPath(`team-members-${width}.png`), fullPage: true });
      await page.getByRole('button', { name: '概览', exact: true }).click();
    }
    await colleague.getByRole('button', { name: /^完善团队协作体验/ }).click();
    await expect(colleague).toHaveURL(/\/tasks$/);
    await expect(colleague.getByRole('heading', { name: '完善团队协作体验', exact: true, level: 2 })).toBeVisible();
    await colleague.getByLabel('切换协作空间').click();
    await colleague.getByRole('button', { name: '个人空间', exact: true }).click();
    await expect(colleague.getByRole('heading', { name: '让协作，从这里开始。' })).toBeVisible();
    await colleague.getByRole('link', { name: '任务中心', exact: true }).click();
    await expect(colleague.getByRole('button', { name: /^完善团队协作体验/ })).toHaveCount(0);
  } finally { await context.close(); }
});
