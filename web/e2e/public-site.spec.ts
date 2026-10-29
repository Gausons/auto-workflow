import { expect, test } from '@playwright/test';

test('website and documentation are public and never request protected account data', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) requests.push(request.url()); });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('让 Agent 工作');
  await page.getByRole('link', { name: '阅读快速开始' }).click();
  await expect(page).toHaveURL(/\/docs\/quickstart$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('快速开始');
  await page.reload();
  await expect(page.getByRole('navigation', { name: '文档导航' }).getByRole('link', { name: '快速开始' })).toHaveAttribute('aria-current', 'page');
  await page.getByRole('navigation', { name: '页内目录' }).getByRole('link', { name: '3. 连接设备' }).click();
  await expect(page).toHaveURL(/#connect$/);
  expect(requests).toEqual([]);
  await page.getByRole('banner').getByRole('link', { name: '进入工作台', exact: true }).click();
  await expect(page.getByRole('heading', { name: '登录 AgentFlow' })).toBeVisible();
});

test('documentation full text search supports results, empty state and keyboard access', async ({ page }) => {
  await page.goto('/docs');
  await page.keyboard.press('/');
  const search = page.getByRole('searchbox', { name: '搜索文档' });
  await expect(search).toBeFocused();
  await search.fill('PGPASSWORD');
  await expect(page.locator('#search-results')).toContainText('自托管部署');
  await page.locator('#search-results').getByRole('link', { name: /自托管部署/ }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('自托管部署');
  await search.fill('<img src=x onerror=alert(1)>');
  await expect(page.locator('#search-results')).toContainText('没有找到结果');
  await expect(page.locator('#search-results img')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('#search-results')).toBeHidden();
});

test('code copying and persisted theme work', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/docs/quickstart');
  await page.getByRole('button', { name: '复制代码' }).first().click();
  await expect(page.getByRole('button', { name: '复制代码' }).first()).toHaveText('已复制');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('agent-workbench-connector');
  await page.getByRole('button', { name: '切换明暗主题' }).click();
  const theme = await page.locator('html').getAttribute('data-theme');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme!);
});

test('public pages fit desktop and phone, with usable mobile document navigation', async ({ page }, testInfo) => {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const route of ['/', '/docs', '/docs/workspaces', '/docs/api', '/docs/self-hosting']) {
      await page.goto(route);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth), `${route} at ${width}`).toBe(width);
      if (route === '/' || route === '/docs/api') await page.screenshot({ path: testInfo.outputPath(`public-${route === '/' ? 'home' : 'docs'}-${width}.png`), fullPage: true });
    }
    if (width === 390) {
      await page.getByRole('button', { name: '文档目录' }).click();
      await page.getByRole('navigation', { name: '文档导航' }).getByRole('link', { name: '设备与 Agent' }).click();
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('设备与 Agent');
    }
  }
});

test('unknown docs return 404 and legacy and Google login links retain their behavior', async ({ page, request }) => {
  expect((await request.get('/docs/nonexistent')).status()).toBe(404);
  await page.goto('/#devices');
  await expect(page).toHaveURL(/\/devices$/);
  await expect(page.getByRole('heading', { name: '登录 AgentFlow' })).toBeVisible();
  await page.goto('/?auth_error=Google%20登录已取消');
  await expect(page.getByRole('alert')).toHaveText('Google 登录已取消');
});

test('Google exchange on the homepage finishes at the workbench instead of the public website', async ({ page }) => {
  await page.route('**/api/auth/google/exchange', route => route.fulfill({ json: { token: 'test-only-expired-session' } }));
  await page.goto('/?google_login=test-only-exchange');
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(page.getByRole('heading', { name: '登录 AgentFlow' })).toBeVisible();
});


test('workspace documentation is discoverable, links to its API and preserves deep links', async ({ page, context }) => {
  const protectedRequests: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) protectedRequests.push(request.url()); });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await page.getByRole('link', { name: /团队协作空间/ }).click();
  await expect(page).toHaveURL(/\/docs\/workspaces$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('团队协作空间');
  await page.getByRole('navigation', { name: '页内目录' }).getByRole('link', { name: '成员角色与访问权限' }).click();
  await expect(page).toHaveURL(/#roles$/);
  await page.reload();
  await expect(page.getByRole('cell', { name: '只读成员（viewer）', exact: true })).toBeVisible();
  await page.getByRole('searchbox', { name: '搜索文档' }).fill('站内邀请');
  await page.locator('#search-results').getByRole('link', { name: /^团队协作空间/ }).click();
  await expect(page.getByRole('navigation', { name: '文档导航' }).getByRole('link', { name: '团队协作空间', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.getByRole('link', { name: '工作空间 API', exact: true }).click();
  await expect(page).toHaveURL(/\/docs\/api#workspaces$/);
  await page.locator('#workspaces').getByRole('button', { name: '复制代码' }).first().click();
  const example = JSON.parse(await page.evaluate(() => navigator.clipboard.readText())) as { name: string; requestId: string };
  expect(example.name).toBe('产品研发团队');
  expect(example.requestId).toMatch(/^[a-zA-Z0-9-]{16,64}$/);
  await expect(page.getByRole('cell', { name: 'PATCH /api/organization/members/:id', exact: true })).toBeVisible();
  expect(protectedRequests).toEqual([]);
});
