import { expect, test } from '@playwright/test';
import { prepareSessionImage } from '../../src/historyImages.js';
import { connectDeviceUpdates } from '../../src/deviceControlClient.js';
import type { SendExecutionFeedback } from '../../shared/realtime.js';

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

test('integration settings group fields and save the assignee select at desktop and mobile widths', async ({ page }, testInfo) => {
  await login(page);
  let assignee = '001';
  let configPayload: Record<string, unknown> = {};
  await page.route('**/api/bootstrap', async route => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({ json: { ...data, config: { ...data.config, assignee, workspaceManaged: true }, assignmentPeople: [{ name: '小李', employeeId: '42', responsibility: '前端' }] } });
  });
  await page.route('**/api/config', async route => {
    configPayload = route.request().postDataJSON() as Record<string, unknown>;
    const response = await route.fetch();
    const data = await response.json();
    assignee = String(configPayload.assignee);
    await route.fulfill({ json: { ...data, config: { ...data.config, assignee, workspaceManaged: true }, assignmentPeople: [{ name: '小李', employeeId: '42', responsibility: '前端' }] } });
  });
  await page.goto('/settings/config');
  const select = page.getByRole('combobox', { name: '扩展数据源经办人', exact: true });
  await expect(select).toHaveValue('001');
  await expect(page.getByRole('textbox', { name: '扩展数据源经办人' })).toHaveCount(0);
  await expect(page.getByLabel('OpenAI Base URL')).toBeHidden();
  for (const width of [1440, 1000, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const name of ['数据源', '定时同步', '智能分配']) await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    const source = await select.boundingBox();
    const operator = await page.getByLabel('扩展数据源操作人', { exact: true }).boundingBox();
    if (width === 390) expect(operator!.y).toBeGreaterThan(source!.y + source!.height);
    else expect(operator!.y).toBe(source!.y);
    const form = await page.locator('#configForm').boundingBox();
    const save = await page.getByRole('button', { name: '保存配置', exact: true }).boundingBox();
    expect(save!.x).toBeGreaterThanOrEqual(form!.x);
    expect(save!.x + save!.width).toBeLessThanOrEqual(form!.x + form!.width);
    await page.screenshot({ path: testInfo.outputPath(`integration-settings-${width}.png`), fullPage: true });
  }
  await select.selectOption('42');
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('配置已保存');
  expect(configPayload.assignee).toBe('42');
  expect(configPayload).not.toHaveProperty('codexWorkspaceDir');
  await page.reload();
  await expect(select).toHaveValue('42');
  await page.getByText('高级配置', { exact: false }).click();
  await expect(page.getByLabel('OpenAI Base URL')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await select.selectOption('');
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('配置已保存');
  expect(configPayload.assignee).toBe('');
});

test('page configuration survives navigation and reload without changing Git branches', async ({ page }) => {
  const projects = ['first', 'selected'].map(id => ({ id, deviceId: 'local', deviceName: '本机', name: id === 'first' ? 'Codex' : 'Claude Code', cwd: '/repo', online: true,
    models: [{ id: 'model', name: '测试模型', reasoningEfforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }] }], defaultModel: 'model' }));
  const gitActions: string[] = [];
  await page.route('**/api/task-center/codex', route => route.fulfill({ json: { projects } }));
  await page.route('**/api/task-center/git', route => {
    const body = route.request().postDataJSON() as { action: string; cwd: string };
    gitActions.push(body.action);
    return route.fulfill({ json: { repository: true, current: body.cwd === '/repo/remembered' ? 'feature/remembered' : 'main', branches: ['main', 'feature/remembered'], changes: 0 } });
  });
  await page.route('**/api/agent-sessions?*', route => route.fulfill({ json: { offset: 0, limit: 30, total: 0, scope: 'all', sessions: [], providers: [{ id: 'codex', label: 'Codex', status: 'available' }], workspaces: [{ path: '/repo/history', count: 0 }] } }));
  await login(page);
  const sidebar = page.getByRole('navigation', { name: '主导航' });
  await sidebar.getByRole('link', { name: 'Agent 历史会话' }).click();
  await page.getByRole('combobox', { name: 'Agent', exact: true }).selectOption('codex');
  await page.getByRole('combobox', { name: '工作区', exact: true }).selectOption('/repo/history');
  await sidebar.getByRole('link', { name: '新建任务' }).click();
  await page.getByLabel('执行位置', { exact: true }).selectOption('1');
  await page.getByLabel('工作目录：/repo', { exact: true }).click();
  await page.getByLabel('工作目录', { exact: true }).fill('/repo/remembered');
  await expect(page.getByLabel('Git 分支', { exact: true })).toContainText('feature/remembered');
  await page.getByLabel('模型与思考强度').click();
  await page.getByLabel('模型', { exact: true }).selectOption('model');
  await page.getByRole('slider', { name: '思考强度' }).fill('1');
  await sidebar.getByRole('link', { name: '任务中心', exact: true }).click();
  await sidebar.getByRole('link', { name: '新建任务' }).click();
  await page.reload();
  await expect(page.getByLabel('执行位置', { exact: true })).toHaveValue('1');
  await expect(page.getByLabel('工作目录：/repo/remembered', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Git 分支', { exact: true })).toContainText('feature/remembered');
  await page.getByLabel('模型与思考强度').click();
  await expect(page.getByLabel('模型', { exact: true })).toHaveValue('model');
  await expect(page.getByRole('slider', { name: '思考强度' })).toHaveAttribute('aria-valuetext', '高');
  await sidebar.getByRole('link', { name: 'Agent 历史会话' }).click();
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Agent', exact: true })).toHaveValue('codex');
  await expect(page.getByRole('combobox', { name: '工作区', exact: true })).toHaveValue('/repo/history');
  expect(gitActions.length).toBeGreaterThan(0);
  expect(gitActions.every(action => action === 'list')).toBe(true);
});

test('all tabs share sidebar geometry, typography and page headings at every breakpoint', async ({ page }, testInfo) => {
  await login(page);
  for (const width of [1440, 1000, 800, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/tasks');
    await expect(page.locator('.main h1')).toHaveText('任务中心');
    await page.locator('.sidebar').evaluate(element => { element.setAttribute('data-shared-shell', 'retained'); });
    const measure = () => page.evaluate(() => {
      const appearance = (selector: string) => {
        const element = document.querySelector(selector)!;
        const style = getComputedStyle(element);
        return { fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight, lineHeight: style.lineHeight, padding: style.padding, gap: style.gap, borderRadius: style.borderRadius, color: style.color, display: style.display };
      };
      const sidebar = document.querySelector('.sidebar')!.getBoundingClientRect();
      return {
        sidebar: { width: sidebar.width, height: sidebar.height, ...appearance('.sidebar') },
        brand: appearance('.brand'), brandTitle: appearance('.brand strong'), brandSubtitle: appearance('.brand span'),
        brandMark: document.querySelector('.brand-mark')!.getBoundingClientRect().toJSON(),
        navigation: Array.from(document.querySelectorAll('.nav-list a'), link => ({
          height: link.getBoundingClientRect().height,
          fontSize: getComputedStyle(link).fontSize, lineHeight: getComputedStyle(link).lineHeight,
          padding: getComputedStyle(link).padding, gap: getComputedStyle(link).gap,
          iconWidth: link.querySelector('svg')!.getBoundingClientRect().width
        })),
        settings: appearance('.settings-link'), note: appearance('.sidebar-note'), account: appearance('.tenant-panel'),
        accountName: appearance('.tenant-panel strong'), logout: appearance('.tenant-panel button'),
        heading: appearance('.page-heading'), title: appearance('.page-heading h1')
      };
    });
    const baseline = await measure();
    expect(baseline.sidebar.width).toBe(width > 1100 ? 232 : width > 860 ? 208 : width);
    expect(baseline.navigation.every(link => link.fontSize === '14px' && link.height === 42)).toBe(true);
    expect(baseline.title.fontSize).toBe('18px');
    const destinations = [
      ['/tasks/new', '新建任务', 'a[href="/tasks/new"]'], ['/tasks', '任务中心', '.nav-list a[href="/tasks"]'],
      ['/inbox', '未归属会话', '.main a[href="#inbox"]'], ['/devices', '设备与 Agent', '.nav-list a[href="/devices"]'],
      ['/workbench', '缺陷工作台', '.nav-list a[href="/workbench"]'], ['/history', '会话', '.nav-list a[href="/history"]'],
      ['/settings/assignment', '设置', '.settings-link'], ['/settings/config', '设置', '.settings-nav a[href="/settings/config"]'],
      ['/settings/account', '设置', '.settings-nav a[href="/settings/account"]']
    ];
    for (const [path, title, selector] of destinations) {
      await page.locator(selector!).click();
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      await expect(page.locator('.main h1')).toHaveText(title!);
      await expect(page.locator('.sidebar')).toHaveAttribute('data-shared-shell', 'retained');
      await page.evaluate(() => window.scrollTo(0, 0));
      expect(await measure(), `${path} at ${width}px`).toEqual(baseline);
      expect(await page.evaluate(() => document.documentElement.scrollWidth), `${path} overflow at ${width}px`).toBe(width);
      await expect(page.locator('.sidebar a[aria-current="page"]')).toHaveCount(1);
      if (path === '/workbench') await expect(page.getByRole('button', { name: '立即拉取' })).toBeVisible();
      if ((width === 1440 || width === 390) && (path === '/history' || path === '/devices')) {
        await page.screenshot({ path: testInfo.outputPath(`shared-ui-${path.slice(1)}-${width}.png`) });
      }
    }
  }
});

test('devices and task center have independent pages and navigation', async ({ page }) => {
  await login(page);
  const sidebar = page.getByRole('navigation', { name: '主导航' });
  const taskViews = page.getByRole('navigation', { name: '任务中心视图' });
  await expect(taskViews.getByRole('link')).toHaveCount(2);
  await expect(taskViews.getByRole('link', { name: /设备与 Agent/ })).toHaveCount(0);
  await taskViews.getByRole('link', { name: /未归属会话/ }).click();
  await expect(page).toHaveURL(/\/inbox$/);
  await expect(taskViews.getByRole('link')).toHaveCount(2);
  await sidebar.getByRole('link', { name: '设备与 Agent', exact: true }).click();
  await expect(page).toHaveURL(/\/devices$/);
  await expect(taskViews).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '连接本机 Agent' })).toHaveCount(0);
  await expect(page.getByText('仅运行工作台', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '连接设备', exact: true }).click();
  await expect(page.getByRole('heading', { name: '连接本机 Agent' })).toBeVisible();
  await expect(sidebar.getByRole('link', { name: '设备与 Agent', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.reload();
  await expect(page.getByRole('heading', { name: '设备与 Agent', exact: true })).toBeVisible();
  await expect(taskViews).toHaveCount(0);
  await sidebar.getByRole('link', { name: '任务中心', exact: true }).click();
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(taskViews.getByRole('link')).toHaveCount(2);
  await expect(page.getByRole('heading', { name: '连接本机 Agent' })).toHaveCount(0);
  await page.goBack();
  await expect(page.getByRole('heading', { name: '设备与 Agent', exact: true })).toBeVisible();
  await expect(taskViews).toHaveCount(0);
  await page.goto('/#devices');
  await expect(page).toHaveURL(/\/devices$/);
  await expect(page.getByRole('heading', { name: '设备与 Agent', exact: true })).toBeVisible();
  await expect(taskViews).toHaveCount(0);
});

test('compact device cards remove, restore and fit desktop and mobile screens', async ({ page, request }) => {
  const response = await request.post('/api/auth/login', { data: { username: 'owner', password } });
  const { token } = await response.json() as { token: string };
  const headers = { Authorization: `Bearer ${token}` };
  const name = 'MacBook-Pro-development-device-with-a-long-name';
  expect((await request.post('/api/task-center', { headers, data: { action: 'heartbeat', deviceId: 'card-layout', name, agents: ['codex', 'claude'], codexProjects: [{ id: 'p', name: 'Codex', cwd: '/repo' }], sessions: [] } })).ok()).toBeTruthy();
  await login(page);
  await page.goto('/devices');
  const card = page.getByRole('article', { name, exact: true });
  await expect(card).toBeVisible();
  await expect(card.getByText('在线', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '连接本机 Agent' })).toHaveCount(0);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const box = await card.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeLessThanOrEqual(width === 390 ? 354 : 340);
    expect(box!.height).toBeLessThan(320);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (width === 1440) await page.screenshot({ path: '/tmp/auto-workflow-devices-desktop.png', fullPage: true });
    else await page.screenshot({ path: '/tmp/auto-workflow-devices-mobile.png', fullPage: true });
  }
  await card.getByRole('button', { name: `删除 ${name} 卡片` }).click();
  await card.getByRole('button', { name: '取消' }).click();
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: `删除 ${name} 卡片` }).click();
  await card.getByRole('button', { name: '确认删除' }).click();
  await expect(card).toHaveCount(0);
  await page.reload();
  await expect(card).toHaveCount(0);
  await page.getByText(/已删除的卡片 ·/).click();
  await page.getByRole('button', { name: `恢复 ${name}`, exact: true }).click();
  await expect(card).toBeVisible();
});

test('remote task setup shows the selected device state without server execution errors', async ({ page }) => {
  await login(page);
  let branchRequests = 0;
  await page.route('**/api/task-center/codex', route => route.fulfill({ json: {
    localExecutionEnabled: false, localError: null,
    projects: [{ id: 'remote-project', name: 'Codex', deviceId: 'remote', deviceName: '开发机', cwd: '/repo', online: false, gitBranches: true }]
  } }));
  page.on('request', request => { if (request.url().includes('/api/task-center/git')) branchRequests++; });
  await page.getByRole('link', { name: '新建任务', exact: true }).click();
  await expect(page.getByText('所选设备离线，任务提交后将等待连接器上线。', { exact: false })).toBeVisible();
  await expect(page.getByText(/ENOENT|工作台所在设备无法提供执行目标|分支读取失败/)).toHaveCount(0);
  await page.getByLabel('Git 分支', { exact: true }).click();
  await expect(page.getByText('设备连接后可读取和管理分支。')).toBeVisible();
  expect(branchRequests).toBe(0);
  await page.setViewportSize({ width: 390, height: 900 });
  await expect(page.getByRole('textbox', { name: '任务描述' })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

test('a common repository under the remote workspace reads branches and submits a task without another directory picker', async ({ page, request }) => {
  const { token } = await (await request.post('/api/auth/login', { data: { username: 'owner', password } })).json() as { token: string };
  const headers = { Authorization: `Bearer ${token}` }, deviceId = 'common-directory-device', cwd = '/remote/work/yonclaw';
  expect((await request.post('/api/task-center', { headers, data: {
    action: 'heartbeat', deviceId, name: '常用目录设备', agents: ['codex'], capabilities: { gitBranches: true },
    codexProjects: [{ id: 'common-project', name: 'Codex', cwd: '/remote/work' }],
    sessions: [{ nativeId: 'existing-common-session', agent: 'codex', title: '已有仓库', cwd }]
  } })).ok()).toBeTruthy();
  // A controlled connector reports Git results; no local Agent is launched.
  const branchStatuses: number[] = [];
  await page.route('**/api/task-center/git', async route => {
    const response = await route.fetch();
    branchStatuses.push(response.status());
    const pending = await response.json() as { id: string; status?: string };
    if (pending.status === 'pending') {
      expect((await request.post('/api/task-center/git-action', { headers, data: { requestId: pending.id, action: 'claim' } })).ok()).toBeTruthy();
      expect((await request.post('/api/task-center/git-action', { headers, data: { requestId: pending.id, action: 'report', status: 'completed', result: { repository: true, current: 'main', branches: ['main'], changes: 0 } } })).ok()).toBeTruthy();
    }
    await route.fulfill({ response });
  });
  let directoryPickers = 0;
  page.on('request', req => { if (req.url().includes('/api/task-center/directory-picker') && req.method() === 'POST') directoryPickers++; });
  await login(page);
  await page.goto(`/tasks/new?deviceId=${deviceId}`);
  await expect(page.getByLabel('Git 分支', { exact: true })).toContainText('main');
  await page.getByLabel('工作目录：/remote/work', { exact: true }).click();
  await page.getByRole('button', { name: cwd, exact: true }).click();
  await expect(page.getByLabel(`工作目录：${cwd}`, { exact: true })).toBeVisible();
  await expect.poll(() => branchStatuses.length).toBeGreaterThanOrEqual(2);
  await expect(page.getByLabel('Git 分支', { exact: true })).toContainText('main');
  await expect(page.getByText(/授权此工作目录|分支读取失败/)).toHaveCount(0);
  await page.getByRole('textbox', { name: '任务描述' }).fill('常用目录直接执行回归');
  const submitted = page.waitForResponse(response => response.url().endsWith('/api/task-center/execute') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '创建并发送任务' }).click();
  expect((await submitted).status()).toBe(202);
  const snapshot = await (await request.get('/api/task-center', { headers })).json() as { executions: Array<{ deviceId: string; cwd: string }> };
  expect(snapshot.executions.some(job => job.deviceId === deviceId && job.cwd === cwd)).toBe(true);
  expect(branchStatuses.every(status => status === 200)).toBe(true);
  expect(directoryPickers).toBe(0);
});

test('auth form stays centered and usable on desktop and mobile', async ({ page }) => {
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/tasks');
    await expect(page.getByRole('heading', { name: '登录 AgentFlow' })).toBeVisible();
    const form = page.locator('#loginForm');
    const bounds = await form.boundingBox();
    expect(bounds).not.toBeNull();
    expect(Math.abs(bounds!.x + bounds!.width / 2 - width / 2)).toBeLessThan(2);
    expect(bounds!.width).toBeLessThanOrEqual(360);
    const submit = await page.getByRole('button', { name: '登录', exact: true }).boundingBox();
    const google = await page.getByRole('link', { name: '使用 Google 单点登录' }).boundingBox();
    expect(google!.y).toBeGreaterThan(submit!.y + submit!.height);
    await page.getByRole('textbox', { name: '用户名', exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('密码', { exact: true })).toBeFocused();
    await page.getByRole('button', { name: '首次使用？注册个人账号' }).click();
    await expect(page.getByLabel('显示名称')).toBeVisible();
    await expect(page.getByRole('button', { name: '注册并进入' })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  }
});

test('remote images appear directly outside and inside the preview window and load near the viewport', async ({ page, request }) => {
  const { token } = await (await request.post('/api/auth/login', { data: { username: 'owner', password } })).json() as { token: string };
  const headers = { Authorization: `Bearer ${token}` }, deviceId = 'image-browser-source', nativeId = 'image-browser-session';
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  const dataUrl = `data:image/png;base64,${Buffer.concat([png, Buffer.alloc(300000)]).toString('base64')}`;
  const image = prepareSessionImage(1, 0, '这张截图来自会话开头。'.repeat(40), { dataUrl, alt: '完整原始截图' });
  const inlineImage = prepareSessionImage(115, 0, '最近的截图', { dataUrl, alt: '消息中的截图' });
  const remoteHistory = { offset: 85, total: 115, sourcePartial: false, truncated: false,
    messages: [...Array.from({ length: 29 }, (_, i) => ({ role: 'assistant', text: `最近记录 ${86 + i}` })), { role: 'user', text: '最近的截图', images: [{ external: true, alt: '图片单独同步' }] }] };
  expect((await request.post('/api/task-center', { headers, data: { action: 'heartbeat', deviceId, name: '图片浏览器设备', agents: ['codex'],
    sessions: [{ nativeId, agent: 'codex', title: '新增图片查看回归', remoteHistory }] } })).ok()).toBeTruthy();
  expect((await request.post('/api/task-center/history-images', { headers, data: { deviceId, nativeId, agent: 'codex', image } })).ok()).toBeTruthy();
  expect((await request.post('/api/task-center/history-images', { headers, data: { deviceId, nativeId, agent: 'codex', image: inlineImage } })).ok()).toBeTruthy();
  const { sessions } = await (await request.get('/api/agent-sessions', { headers })).json() as { sessions: Array<{ id: string; deviceId: string }> };
  const id = sessions.find(session => session.deviceId === deviceId)!.id;
  await login(page);
  const reads: string[] = [];
  page.on('request', req => { if (/\/images\/[a-f0-9]{64}$/.test(req.url())) reads.push(req.url()); });
  let releaseMetadata!: () => void;
  const metadataGate = new Promise<void>(resolve => { releaseMetadata = resolve; });
  await page.route(`**/api/agent-sessions/${id}/images?*`, async route => { await metadataGate; await route.continue(); });
  await page.goto(`/history/${id}`);
  const recentMessage = page.locator('.history-message.user').filter({ hasText: '最近的截图' });
  await expect(recentMessage).toBeInViewport();
  expect(reads).toHaveLength(0);
  releaseMetadata();
  await expect(page.getByText('这张截图来自会话开头')).toBeVisible();
  await expect(recentMessage).toBeInViewport();
  await recentMessage.scrollIntoViewIfNeeded();
  await expect(page.getByText('已同步 30 / 115 条记录', { exact: true })).toBeVisible();
  const recentPreview = page.locator('.history-message.user').getByAltText('消息中的截图');
  await expect(recentPreview).toBeVisible();
  expect(reads).toHaveLength(1);
  await expect(page.getByText('这张截图来自会话开头')).toBeVisible();
  const preview = page.getByAltText('完整原始截图');
  await page.getByText('这张截图来自会话开头').scrollIntoViewIfNeeded();
  await expect(preview).toBeVisible();
  await expect.poll(() => preview.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
  expect(reads).toHaveLength(2);
  await expect(page.locator('figure').filter({ has: preview }).getByRole('link', { name: '下载原图' })).toHaveAttribute('href', dataUrl);
  await expect(page.getByText('以下图片来自更早的记录，完整正文未同步。')).toBeVisible();
  await page.locator('.history-message.user').filter({ hasText: '最近的截图' }).scrollIntoViewIfNeeded();
  const inlinePreview = page.locator('.history-message.user').getByAltText('消息中的截图');
  await expect(inlinePreview).toBeVisible();
  await expect.poll(() => inlinePreview.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
  expect(reads).toHaveLength(2);
});

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

test('remote branch selector creates through the connector queue while its cached list refreshes', async ({ page }) => {
  let current = 'main';
  let lists = 0, refreshId = '';
  await page.route('**/api/task-center/codex', route => route.fulfill({ json: { projects: [{ id: 'p', deviceId: 'remote', deviceName: '开发机', name: 'Codex', cwd: '/repo', online: true, gitBranches: true }] } }));
  await page.route('**/api/task-center/git*', route => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      expect(body.deviceId).toBe('remote');
      if (body.action === 'list' && ++lists > 1) refreshId = body.requestId;
      if (body.action === 'create') current = body.branch;
      return route.fulfill({ json: { id: body.requestId, status: 'pending' } });
    }
    if (new URL(route.request().url()).searchParams.get('requestId') === refreshId) return route.fulfill({ json: { status: 'running' } });
    return route.fulfill({ json: { status: 'completed', result: { repository: true, current, changes: 0, branches: ['main', ...(current !== 'main' ? [current] : [])] } } });
  });
  await login(page);
  await page.getByRole('link', { name: '新建任务', exact: true }).click();
  await expect(page.getByLabel('Git 分支')).toContainText('main');
  await page.getByLabel('Git 分支').click();
  await expect(page.getByText('正在刷新分支…')).toBeVisible();
  await expect(page.getByRole('button', { name: 'main ✓', exact: true })).toBeEnabled();
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

test('external task changes update the page incrementally without refetching its snapshot or reconnecting WebSocket', async ({ page, request }) => {
  const { token } = await (await request.post('/api/auth/login', { data: { username: 'owner', password } })).json() as { token: string };
  const headers = { Authorization: `Bearer ${token}` };
  const reads: string[] = [], sockets: string[] = [];
  page.on('websocket', socket => sockets.push(new URL(socket.url()).pathname));
  page.on('request', req => { if (req.method() === 'GET') reads.push(new URL(req.url()).pathname); });
  await login(page);
  await expect.poll(() => sockets.filter(path => path === '/api/realtime').length).toBe(1);
  const fullReads = reads.filter(path => path === '/api/task-center').length;
  const created = await request.post('/api/task-center', { headers, data: { action: 'create', title: '跨端增量同步回归' } });
  expect(created.ok()).toBeTruthy();
  const { taskId } = await created.json() as { taskId: string };
  await expect(page.getByText('跨端增量同步回归', { exact: true }).first()).toBeVisible();
  expect((await request.post('/api/task-center', { headers, data: { action: 'update', taskId, revision: 1, content: '跨端增量更新回归', status: 'ready' } })).ok()).toBeTruthy();
  await expect(page.getByText('跨端增量更新回归', { exact: true }).first()).toBeVisible();
  expect(reads.filter(path => path === '/api/task-center/changes').length).toBeGreaterThan(0);
  expect(reads.filter(path => path === '/api/task-center').length).toBe(fullReads);
  expect(sockets.filter(path => path === '/api/realtime').length).toBe(1);
});

test('open history receives only its changed remote preview without a page reload', async ({ page, request }) => {
  const { token } = await (await request.post('/api/auth/login', { data: { username: 'owner', password } })).json() as { token: string };
  const headers = { Authorization: `Bearer ${token}` }, deviceId = 'incremental-history-device';
  const heartbeat = (text: string) => ({ action: 'heartbeat', deviceId, name: '增量历史设备', agents: ['codex'], sessions: [{ nativeId: 'incremental-preview', agent: 'codex', title: '增量正文回归', remoteHistory: { offset: 0, total: 1, sourcePartial: false, truncated: false, messages: [{ role: 'assistant', text }] } }] });
  expect((await request.post('/api/task-center', { headers, data: heartbeat('同步前的正文') })).ok()).toBeTruthy();
  const { sessions } = await (await request.get('/api/agent-sessions', { headers })).json() as { sessions: Array<{ id: string; deviceId: string }> };
  const id = sessions.find(session => session.deviceId === deviceId)!.id;
  await login(page); await page.goto(`/history/${id}`);
  await expect(page.getByText('同步前的正文', { exact: true })).toBeVisible();
  const patch = page.waitForResponse(response => new URL(response.url()).pathname === '/api/task-center/changes');
  expect((await request.post('/api/task-center', { headers, data: heartbeat('同步后的正文') })).ok()).toBeTruthy();
  await patch;
  await expect(page.getByText('同步后的正文', { exact: true })).toBeVisible();
  await expect(page.getByText('同步前的正文', { exact: true })).toHaveCount(0);
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

test('history list scrolls independently while search and filters stay visible', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const sessions = Array.from({ length: 30 }, (_, index) => ({ id: index.toString(16).padStart(64, '0'), agent: 'codex', agentLabel: 'Codex', deviceId: 'remote', title: `历史会话 ${index + 1}`, cwd: '/repo', status: 'completed', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-05T00:00:00Z', messageCount: 95, recordMode: 'synced', partial: true }));
  await page.route('**/api/agent-sessions?*', route => route.fulfill({ json: { offset: 0, limit: 30, total: 30, scope: 'all', providers: [{ id: 'codex', label: 'Codex', status: 'available' }], workspaces: [], sessions } }));
  await login(page); await page.goto('/history');
  const search = page.getByRole('textbox', { name: '搜索会话' });
  await expect(search).toBeVisible();
  const before = await search.boundingBox();
  await page.getByRole('button', { name: /^历史会话 30 / }).scrollIntoViewIfNeeded();
  await expect(search).toBeInViewport();
  await expect(page.getByRole('combobox', { name: '工作区', exact: true })).toBeInViewport();
  expect((await search.boundingBox())?.y).toBe(before?.y);
  expect(await page.locator('.history-list').evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  expect(await page.getByRole('complementary', { name: '历史会话列表' }).evaluate(element => element.scrollTop)).toBe(0);
  await page.screenshot({ path: testInfo.outputPath('history-fixed-filters.png') });
});

test('history conversation scroll stays inside the viewport with a docked composer', async ({ page }, testInfo) => {
  const id = 'e'.repeat(64);
  const session = { id, sessionId: id, agent: 'codex', agentLabel: 'Codex', deviceId: 'local', title: '长会话滚动回归', cwd: '/repo', status: 'completed', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-05T00:00:00Z', messageCount: 40 };
  const messages = Array.from({ length: 40 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', text: `第 ${index + 1} 条记录\n\n${'用于验证历史正文独立滚动。'.repeat(12)}` }));
  await page.route('**/api/agent-sessions?*', route => route.fulfill({ json: { offset: 0, limit: 30, total: 1, scope: 'all', providers: [{ id: 'codex', label: 'Codex', status: 'available' }], workspaces: [], sessions: [session] } }));
  await page.route(`**/api/agent-sessions/${id}?*`, route => route.fulfill({ json: { session, messages, total: messages.length } }));
  await page.route(`**/api/agent-sessions/${id}/continue`, route => route.fulfill({ json: { execution: null, executions: [] } }));
  await login(page);
  await page.goto(`/history/${id}`);
  const composer = page.getByRole('region', { name: '会话输入框' });
  const transcript = page.locator('.history-chat-scroll');
  await expect(composer).toBeVisible();
  for (const viewport of [{ width: 1440, height: 812 }, { width: 1000, height: 700 }, { width: 800, height: 900 }]) {
    await page.setViewportSize(viewport);
    const before = await composer.boundingBox();
    await transcript.evaluate(element => { element.scrollTo({ top: element.scrollHeight, behavior: 'instant' }); });
    await expect(page.getByText('已显示 40 / 40 条记录')).toBeInViewport();
    await transcript.hover();
    await page.mouse.wheel(0, 800);
    // Allow the wheel event to reach any ancestor scroll containers.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await page.evaluate(() => ({ top: window.scrollY, height: document.documentElement.scrollHeight }))).toEqual({ top: 0, height: viewport.height });
    expect(await composer.boundingBox()).toEqual(before);
    expect(before!.y + before!.height).toBeCloseTo(viewport.height, 0);
    await expect(page.getByRole('textbox', { name: '搜索会话' })).toBeInViewport();
    await expect(page.getByRole('heading', { name: '长会话滚动回归' })).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath(`history-scroll-${viewport.width}.png`) });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await composer.scrollIntoViewIfNeeded();
  await transcript.evaluate(element => { element.scrollTo({ top: element.scrollHeight, behavior: 'instant' }); });
  await expect(page.getByText('已显示 40 / 40 条记录')).toBeInViewport();
  await expect(page.getByRole('textbox', { name: '发送消息' })).toBeInViewport();
  const mobile = await page.evaluate(() => ({
    height: document.documentElement.scrollHeight,
    bottom: document.querySelector('.history-layout')!.getBoundingClientRect().bottom + window.scrollY,
    width: document.documentElement.scrollWidth
  }));
  expect(mobile.height).toBeCloseTo(mobile.bottom, 0);
  expect(mobile.width).toBe(390);
  await page.screenshot({ path: testInfo.outputPath('history-scroll-mobile.png'), fullPage: true });
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

test('history uses Codex-style message layout, folded progress and Markdown tables', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1100 });
  const id = 'd'.repeat(64);
  const session = { id, sessionId: id, agent: 'codex', agentLabel: 'Codex', deviceId: 'remote', canContinue: true, title: '核对服务器部署结果', cwd: '/repo', createdAt: '2026-10-02T13:52:00Z', updatedAt: '2026-10-02T13:53:21Z', messageCount: 5, recordMode: 'synced', syncedRange: { offset: 0, total: 5, sourcePartial: false, truncated: false } };
  const messages = [
    { role: 'user', text: '继续', timestamp: '2026-10-02T13:52:00Z', turnId: 'turn' },
    { role: 'assistant', phase: 'commentary', text: '我继续核对服务器版本和检查结果。', timestamp: '2026-10-02T13:52:03Z', turnId: 'turn' },
    { role: 'tool_call', name: 'exec_command', text: '检查服务健康状态', timestamp: '2026-10-02T13:52:10Z', turnId: 'turn', callId: 'health' },
    { role: 'tool_result', text: '健康检查通过', timestamp: '2026-10-02T13:52:15Z', turnId: 'turn', callId: 'health' },
    { role: 'assistant', phase: 'final', text: '**升级已完成**：服务器运行新版本 `v1.2.3`，容器健康，HTTPS 返回 200。\n\n请核对以下结果：\n\n| 检查项 | 结果 |\n| --- | --- |\n| 服务版本 | `v1.2.3` |\n| 健康检查 | 已通过 |\n\n无需重复安装或重启服务。', timestamp: '2026-10-02T13:53:21Z', turnId: 'turn' }
  ];
  await page.route('**/api/agent-sessions?*', route => route.fulfill({ json: { offset: 0, limit: 30, total: 1, scope: 'all', providers: [{ id: 'codex', label: 'Codex', status: 'available' }], workspaces: [], sessions: [session] } }));
  await page.route(`**/api/agent-sessions/${id}?*`, route => route.fulfill({ json: { session, messages, total: messages.length } }));
  await page.route(`**/api/agent-sessions/${id}/continue`, route => route.fulfill({ json: { execution: null, executions: [] } }));
  await page.route('**/api/task-center/codex', route => route.fulfill({ json: { projects: [{ id: 'ui-project', agent: 'codex', name: 'Codex', cwd: '/repo', deviceId: 'remote', deviceName: '开发机', online: true, gitBranches: true, defaultModel: 'gpt-6-astra', models: [{ id: 'gpt-6-astra', name: 'GPT-6 Astra', defaultReasoningEffort: 'medium', reasoningEfforts: [{ id: 'medium', name: '中' }] }] }] } }));
  await page.route('**/api/task-center/git*', route => route.fulfill({ json: { status: 'completed', result: { repository: true, current: 'main', changes: 0, branches: ['main'] } } }));
  await login(page);
  await page.goto(`/history/${id}`);
  await expect(page.getByText('可续聊', { exact: true })).toBeVisible();
  await expect(page.getByRole('table')).toBeVisible();
  await expect(page.getByRole('columnheader', { name: '检查项' })).toBeVisible();
  await expect(page.getByText('我继续核对服务器版本和检查结果。', { exact: true })).toBeHidden();
  await expect(page.locator('.history-message.user time')).toHaveAttribute('datetime', '2026-10-02T13:52:00.000Z');
  await expect(page.locator('.history-message.assistant')).toHaveCount(1);
  const geometry = await page.locator('.history-message.user').evaluate(element => {
    const parent = element.getBoundingClientRect();
    const bubble = element.querySelector('.history-message-body')!.getBoundingClientRect();
    return { rightGap: Math.abs(parent.right - bubble.right), bubbleWidth: bubble.width, parentWidth: parent.width };
  });
  expect(geometry.rightGap).toBeLessThan(2);
  expect(geometry.bubbleWidth).toBeLessThan(geometry.parentWidth / 2);
  await expect(page.getByLabel('当前会话配置')).toContainText('Codex');
  await expect(page.getByRole('combobox', { name: '执行位置' })).toHaveCount(0);
  await page.locator('.history-chat-scroll').evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: testInfo.outputPath('codex-style-desktop.png'), fullPage: true });
  await page.locator('.history-detail').screenshot({ path: testInfo.outputPath('codex-style-conversation.png') });
  await page.getByText('使用了 1 次工具').click();
  await expect(page.getByText('我继续核对服务器版本和检查结果。', { exact: true })).toBeVisible();
  await page.getByText('使用了 1 次工具').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.history-detail').scrollIntoViewIfNeeded();
  await expect(page.getByRole('table')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('codex-style-mobile.png'), fullPage: true });
});

test('inherited context opens a bounded detail drawer and new-session shortcuts use selected configuration', async ({ page }, testInfo) => {
  const id = 'e'.repeat(64), source = 'f'.repeat(64), next = '1'.repeat(64);
  const session = { id, managed: true, source: 'conversation', agent: 'codex', agentLabel: 'Codex', deviceId: 'local', title: '上下文交接回归', cwd: '/repo', model: 'model-original', status: 'ready', createdAt: '2026-10-05T00:00:00Z', updatedAt: '2026-10-05T00:00:00Z', messageCount: 0 };
  const inherited = { count: 2, sourceSessionId: source, sourceTitle: '原始排查', availability: 'ready', digest: 'fixture' };
  let previewReads = 0;
  const writes: Array<Record<string, unknown>> = [];
  const ordinarySends: string[] = [];
  await page.route('**/api/agent-sessions?*', route => route.fulfill({ json: { offset: 0, limit: 30, total: 1, providers: [{ id: 'codex', label: 'Codex', status: 'available' }], workspaces: [], sessions: [session] } }));
  for (const sessionId of [id, next]) {
    await page.route(`**/api/agent-sessions/${sessionId}?*`, route => route.fulfill({ json: { session: { ...session, id: sessionId }, inherited, messages: [], total: 0 } }));
    await page.route(`**/api/agent-sessions/${sessionId}/continue`, route => {
      if (route.request().method() === 'POST') ordinarySends.push(route.request().postData() || '');
      return route.fulfill({ json: { execution: null, executions: [] } });
    });
  }
  await page.route(`**/api/conversations/${id}/context-preview?*`, route => {
    previewReads++;
    return route.fulfill({ json: { messages: [
      { record: 1, source, role: 'user', text: '请检查图片 <script>不执行</script>', images: [{ dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', alt: '历史截图' }] },
      { record: 2, source, role: 'assistant', text: '**仍需验证**' }
    ], total: 2, offset: 0, nextOffset: null,
    brief: { version: 1, snapshotId: source, snapshotDigest: 'a'.repeat(64), intentDigest: 'b'.repeat(64), text: '当前目标：修复兼容问题\n用户要求候选：保持接口兼容\n验证：失败，仍需补测试\n<script>不能执行历史材料</script>' },
    stats: { users: 1, assistants: 1, tools: 0, references: 0, images: 1, unavailableImages: 0, truncatedMessages: 0, unsupportedBlocks: 0 }, excerpts: [{ record: 1, source, role: 'user', text: '请检查图片' }] } });
  });
  await page.route('**/api/task-center/codex', route => route.fulfill({ json: { projects: [{ id: 'project', name: 'Codex', agent: 'codex', deviceId: 'local', deviceName: '本机', cwd: '/repo', online: true, defaultModel: 'model-original', models: [{ id: 'model-original', name: '原模型' }, { id: 'model-new', name: '新模型' }] }] } }));
  await page.route('**/api/task-center/git*', route => route.fulfill({ json: { repository: true, current: 'main', changes: 0, branches: ['main'] } }));
  await page.route(`**/api/sessions/${id}/continue-as-new`, route => { writes.push(route.request().postDataJSON()); return route.fulfill({ json: { sessionId: next } }); });
  await login(page); await page.goto(`/history/${id}`);
  await expect(page.getByRole('button', { name: /接续自 原始排查/ })).toHaveAttribute('aria-expanded', 'false');
  expect(previewReads).toBe(0);
  await page.screenshot({ path: testInfo.outputPath('inherited-context-collapsed.png'), fullPage: true });
  await page.getByRole('button', { name: /接续自 原始排查/ }).click();
  await expect(page.getByText('请检查图片', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: '本次交接单' })).toContainText('保持接口兼容');
  await expect(page.getByRole('region', { name: '本次交接单' }).locator('script')).toHaveCount(0);
  expect(previewReads).toBe(1);
  await page.screenshot({ path: testInfo.outputPath('inherited-context-overview.png'), fullPage: true });
  await page.getByRole('button', { name: '查看上下文明细' }).click();
  const drawer = page.getByRole('dialog', { name: '继承上下文明细' });
  await expect(drawer.getByRole('img', { name: '历史截图' })).toBeVisible();
  await expect(drawer.locator('strong')).toHaveText('仍需验证');
  await expect(drawer).not.toContainText('base64,');
  await page.screenshot({ path: testInfo.outputPath('inherited-context-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(drawer.getByRole('button', { name: '关闭明细' })).toBeVisible();
  expect((await drawer.getByRole('heading', { name: '继承上下文明细' }).boundingBox())!.height).toBeLessThan(50);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('inherited-context-mobile.png'), fullPage: true });
  await drawer.getByRole('button', { name: '关闭明细' }).click();
  await expect(page.getByRole('region', { name: '本次交接单' })).toContainText('失败，仍需补测试');
  await expect(page.getByRole('combobox', { name: '模型', exact: true })).toHaveCount(0);
  await page.getByRole('textbox', { name: '发送消息', exact: true }).fill('按最新结果继续');
  await page.getByRole('button', { name: /带上下文新开会话/ }).click();
  await page.getByLabel('模型与思考强度').click();
  await page.getByRole('combobox', { name: '模型', exact: true }).selectOption('model-new');
  await page.getByLabel('模型与思考强度').click();
  await expect(page.getByRole('button', { name: '创建并发送', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('inherited-context-new-session.png'), fullPage: true });
  await page.getByRole('textbox', { name: '新会话首条消息（可选）' }).press('Control+Enter');
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({ targetAgent: 'codex', projectId: 'project', deviceId: 'local', cwd: '/repo', model: 'model-new', message: '按最新结果继续' });
  expect(ordinarySends).toHaveLength(0);
  await expect(page).toHaveURL(new RegExp(`/history/${next}$`));
});

test('creating from remote history confirms the directory before submitting and opening the new session', async ({ page }) => {
  const id = '2'.repeat(64), next = '3'.repeat(64);
  const directoryRequestId = '11111111-1111-4111-8111-111111111111';
  const session = { id, agent: 'codex', deviceId: 'remote', title: '远端上下文创建', cwd: '/remote/history-repo', status: 'completed', updatedAt: '2026-10-05T00:00:00Z', messageCount: 0 };
  const writes: Array<Record<string, unknown>> = [];
  let pickerRequests = 0, confirmed = false;
  await page.route('**/api/agent-sessions?*', route => route.fulfill({ json: { offset: 0, limit: 30, total: 1, providers: [], workspaces: [], sessions: [session] } }));
  for (const sessionId of [id, next]) {
    await page.route(`**/api/agent-sessions/${sessionId}?*`, route => route.fulfill({ json: { session: { ...session, id: sessionId }, messages: [], total: 0 } }));
  }
  await page.route('**/api/task-center/codex', route => route.fulfill({ json: { projects: [{ id: 'remote-project', name: 'Codex', agent: 'codex', deviceId: 'remote', deviceName: '开发机', cwd: '/remote/default', online: true }] } }));
  await page.route('**/api/task-center/git*', route => route.fulfill({ json: { repository: false } }));
  await page.route('**/api/task-center/directory-picker*', route => {
    if (route.request().method() === 'POST') {
      pickerRequests++;
      expect(route.request().postDataJSON()).toEqual({ deviceId: 'remote', projectId: 'remote-project' });
      return route.fulfill({ json: { status: 'pending', requestId: directoryRequestId } });
    }
    return route.fulfill({ json: { status: confirmed ? 'completed' : 'selecting', requestId: directoryRequestId, ...(confirmed ? { cwd: '/remote/confirmed-repo' } : {}) } });
  });
  await page.route(`**/api/sessions/${id}/continue-as-new`, route => {
    writes.push(route.request().postDataJSON());
    return route.fulfill({ json: { sessionId: next } });
  });
  await login(page); await page.goto(`/history/${id}`);
  await page.getByRole('button', { name: /带上下文新开会话/ }).click();
  await expect(page.getByLabel('工作目录：/remote/history-repo')).toBeVisible();
  await page.getByRole('textbox', { name: '新会话首条消息（可选）' }).fill('hi');
  await page.getByRole('button', { name: '创建并发送' }).click();
  await expect(page.getByText(/请在目标设备选择并确认工作目录/)).toBeVisible();
  await expect(page.getByRole('button', { name: '创建并发送' })).toBeDisabled();
  expect(writes).toHaveLength(0);
  confirmed = true;
  await expect(page).toHaveURL(new RegExp(`/history/${next}$`));
  expect(pickerRequests).toBe(1);
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ deviceId: 'remote', projectId: 'remote-project', cwd: '/remote/confirmed-repo', directoryRequestId, message: 'hi' });
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

test('device setup selects remote target and browser controls a remote original session', async ({ page, request, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const loginResult = await request.post('/api/auth/login', { data: { username: 'owner', password } });
  const { token: connectorToken } = await loginResult.json() as { token: string };
  const headers = { Authorization: `Bearer ${connectorToken}` };
  const nativeId = 'c5d32f71-0be1-4507-a9b8-6b843fe29d20';
  const deviceId = 'browser-remote';
  const remoteHistory = { offset: 10, total: 14, sourcePartial: false, truncated: false, messages: [
    { role: 'user', text: '查看远端截图', images: [{ dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', alt: '远端截图' }] },
    { role: 'tool_call', name: 'read_file', callId: 'call', text: '读取源码' },
    { role: 'tool_result', callId: 'call', text: '远端工具结果' },
    { role: 'assistant', text: '**已检查远端截图**' }
  ] };
  const heartbeat = await request.post('/api/task-center', { headers, data: { action: 'heartbeat', deviceId, name: '浏览器远端开发机', agents: ['codex'], capabilities: { resumeCodex: true }, codexProjects: [{ id: 'remote-project', name: '远端项目', cwd: '/remote/repo', agent: 'codex' }], sessions: [{ nativeId, agent: 'codex', agentLabel: 'Codex', title: '远端续聊回归', cwd: '/remote/repo', model: 'test-model', branch: 'main', remoteHistory }] } });
  expect(heartbeat.ok()).toBeTruthy();
  await login(page);
  await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '设备与 Agent', exact: true }).click();
  await expect(page).toHaveURL(/\/devices$/);
  await expect(page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '设备与 Agent', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.reload();
  await page.getByRole('button', { name: '连接设备', exact: true }).click();
  await expect(page.getByRole('heading', { name: '连接本机 Agent' })).toBeVisible();
  await page.getByRole('button', { name: '生成并复制部署命令' }).click();
  const deployment = await page.getByLabel('一键部署命令').inputValue();
  const temporary = JSON.parse(Buffer.from(deployment.split(' ').at(-1)!, 'base64url').toString('utf8'));
  expect(temporary.deploymentToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(temporary).not.toHaveProperty('username');
  expect(deployment).not.toContain(connectorToken);
  const exchanged = await request.post('/api/auth/device-deployment/exchange', { data: { deploymentToken: temporary.deploymentToken } });
  expect(exchanged.ok()).toBeTruthy();
  const deviceSession = await exchanged.json() as { token: string; permissions: string[] };
  expect(deviceSession.permissions).toEqual(['read', 'work.execute']);
  expect((await request.get(`/api/task-center/device-state?deviceId=${deviceId}`, { headers: { Authorization: `Bearer ${deviceSession.token}` } })).ok()).toBeTruthy();
  expect((await request.post('/api/auth/device-deployment/exchange', { data: { deploymentToken: temporary.deploymentToken } })).status()).toBe(401);
  await page.getByRole('button', { name: '已复制，再次复制' }).click();
  await expect(page.getByRole('status')).toContainText('尚未部署');
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByLabel('一键部署命令')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const device = page.locator('article').filter({ has: page.getByRole('heading', { name: '浏览器远端开发机' }) });
  await device.getByText('设备详情', { exact: true }).click();
  await expect(device).toContainText('支持 Codex 原会话续聊');
  await device.getByRole('link', { name: '新建远端任务' }).click();
  await expect(page).toHaveURL(/deviceId=browser-remote/);
  await expect(page.getByRole('combobox', { name: '执行位置' }).locator('option:checked')).toContainText('浏览器远端开发机');
  await expect(page.getByRole('combobox', { name: '执行位置' })).toContainText('远端项目');
  const list = await request.get('/api/agent-sessions', { headers });
  const { sessions } = await list.json() as { sessions: Array<{ id: string; deviceId: string }> };
  const session = sessions.find(item => item.deviceId === deviceId)!;
  await page.goto(`/history/${session.id}`);
  await expect(page.getByText('可续聊', { exact: true })).toBeVisible();
  await page.getByText('已同步 4 / 14 条记录', { exact: true }).click();
  await expect(page.getByText(/已同步第 11–14 条，共 14 条记录/)).toBeVisible();
  await expect(page.locator('.history-message.user')).toContainText('查看远端截图');
  await expect(page.locator('.history-message.assistant strong')).toHaveText('已检查远端截图');
  await expect(page.getByAltText('远端截图')).toBeVisible();
  await page.getByText('使用了 1 次工具').click();
  await page.locator('.history-tool summary').filter({ hasText: '工具结果' }).click();
  await expect(page.getByText('远端工具结果', { exact: true })).toBeVisible();
  await expect(page.getByText(/部分记录损坏/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /远端续聊回归/ })).toContainText('14 条记录');
  await page.getByRole('textbox', { name: '发送消息' }).fill('继续远端测试');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByText(/已排队，准备继续原会话/)).toBeVisible();
  const status = await request.get(`/api/agent-sessions/${session.id}/continue`, { headers });
  const { execution } = await status.json() as { execution: { id: string; resumeThreadId: string; deviceId: string } };
  expect(execution.resumeThreadId).toBe(nativeId); expect(execution.deviceId).toBe(deviceId);
  expect((await request.post('/api/task-center/execution-action', { headers, data: { action: 'claim', executionId: execution.id } })).ok()).toBeTruthy();
  const stopConnection = new AbortController();
  let ready!: (send: SendExecutionFeedback) => void, failed!: (error: unknown) => void;
  const available = new Promise<SendExecutionFeedback>((resolve, reject) => { ready = resolve; failed = reject; });
  const connected = connectDeviceUpdates({ url: new URL('/api/realtime', status.url()), token: connectorToken, deviceId, signal: stopConnection.signal,
    wake() {}, onFeedback(send) { if (send) ready(send); } });
  void connected.catch(failed);
  try {
    const send = await available;
    const report = { threadId: nativeId, status: 'waiting', request: { method: 'item/commandExecution/requestApproval', params: { command: 'echo fixture' } }, output: '受控远端输出' };
    await send({ executionId: execution.id, report });
    await expect(page.getByText('受控远端输出', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '处理请求' }).click();
    await page.getByRole('button', { name: '发送回复', exact: true }).click();
    await expect(page.getByText(/等待目标设备处理操作/)).toBeVisible();
    const pending = await request.get(`/api/agent-sessions/${session.id}/continue`, { headers });
    const current = await pending.json() as { execution: { control: { id: string; action: string; decision: string } } };
    expect(current.execution.control).toMatchObject({ action: 'respond', decision: 'decline' });
    await send({ executionId: execution.id, controlAck: current.execution.control.id, report: { ...report, request: null, status: 'running' } });
    await expect(page.getByText(/等待目标设备处理操作/)).toHaveCount(0);
    await page.getByRole('button', { name: '停止', exact: true }).click();
    const stopped = await request.get(`/api/agent-sessions/${session.id}/continue`, { headers });
    const stop = await stopped.json() as { execution: { control: { id: string; action: string } } };
    expect(stop.execution.control.action).toBe('stop');
    await send({ executionId: execution.id, controlAck: stop.execution.control.id, report: { ...report, request: null, status: 'interrupted' } });
    await expect(page.getByRole('button', { name: '重新编辑本轮消息' })).toBeVisible();
  } finally { stopConnection.abort(); await connected; }
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

test('task workspace keeps controls visible, filters consistently and uses mobile drill-in navigation', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const tasks = Array.from({ length: 30 }, (_, index) => ({
    id: `workspace-task-${index}`, title: index === 0 ? '整理项目 README，补全本地开发与部署说明' : index === 1 ? '修复缺陷 BIP-BUG-00291698：智能体输出时只有脚本结果，缺少思考过程和工作条目，等待时无法判断任务进度' : `优化工作台交互细节 ${index}`,
    status: index === 0 ? 'error' : index % 3 === 0 ? 'completed' : index % 3 === 1 ? 'ready' : 'running',
    revision: 1, contextVersion: 1, content: '## 目标\n整理项目说明，让新成员能够快速启动开发环境。\n\n## 验收标准\n- 补全安装与启动步骤\n- 核对部署说明与常用命令',
    sessionIds: [], events: [], createdAt: '2026-10-04T08:00:00Z', updatedAt: '2026-10-04T09:22:00Z'
  }));
  const executions = Array.from({ length: 18 }, (_, index) => ({ id: `workspace-job-${index}`, taskId: tasks[0]!.id, status: index === 17 ? 'failed' : 'completed', agent: 'codex', agentLabel: 'Codex', deviceId: 'local', cwd: '/repo', title: '整理项目说明', contextVersion: 1, prompt: '整理项目说明', message: index === 17 ? '执行中断，请检查设备连接后再继续。' : '', output: index === 17 ? '' : '已检查项目结构，补充了开发环境说明。', createdAt: `2026-10-04T09:${String(index).padStart(2, '0')}:00Z`, updatedAt: '2026-10-04T09:22:00Z' }));
  await page.route('**/api/task-center', route => route.fulfill({ json: { tasks, sessions: [], devices: [], executions, handoffs: [] } }));
  await login(page);
  const list = page.getByRole('complementary', { name: '任务列表' });
  const detail = page.getByRole('region', { name: '任务详情' });
  const heading = page.getByRole('heading', { name: tasks[0]!.title });
  await expect(heading).toBeVisible();
  const longTask = list.getByRole('button', { name: new RegExp('修复缺陷 BIP-BUG') });
  expect((await longTask.boundingBox())!.height).toBeLessThan(110);
  const action = page.getByRole('button', { name: '继续任务', exact: true });
  const before = await action.boundingBox();
  expect(before!.y + before!.height).toBeLessThanOrEqual(1000);
  // Find the actual independently scrolling ancestor of the timeline.
  await detail.locator('.tc-timeline').evaluate(element => {
    let parent = element.parentElement;
    while (parent && getComputedStyle(parent).overflowY !== 'auto') parent = parent.parentElement;
    if (!parent) throw new Error('活动记录缺少独立滚动容器');
    parent.scrollTop = parent.scrollHeight;
  });
  await expect(page.getByText('执行中断，请检查设备连接后再继续。')).toBeVisible();
  expect((await action.boundingBox())!.y).toBe(before!.y);
  await expect(heading).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('task-workspace-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: '已完成', exact: true }).click();
  await expect(page.getByRole('button', { name: '重新打开任务' })).toBeVisible();
  await page.getByRole('textbox', { name: '搜索任务与会话' }).fill('不存在的任务');
  await expect(page.getByRole('button', { name: '重新打开任务' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '没有匹配的任务' })).toBeVisible();
  await page.getByRole('button', { name: '清除筛选' }).click();
  await expect(heading).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(list).toBeVisible();
  await expect(detail).toBeHidden();
  await longTask.click();
  await expect(detail).toBeVisible();
  await expect(list).toBeHidden();
  await expect(page.getByRole('heading', { name: tasks[1]!.title })).toBeFocused();
  await expect(action).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const mobileAction = await action.boundingBox();
  expect(mobileAction!.y + mobileAction!.height).toBeLessThanOrEqual(844);
  await page.screenshot({ path: testInfo.outputPath('task-workspace-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: '返回任务列表' }).click();
  await expect(list).toBeVisible();
  await expect(longTask).toBeFocused();
  await expect(longTask).toHaveAttribute('aria-pressed', 'true');
});

test('history opens the latest ten turns and preserves the reading position while prepending earlier turns', async ({ page, request }) => {
  const { token } = await (await request.post('/api/auth/login', { data: { username: 'owner', password } })).json() as { token: string };
  const headers = { Authorization: `Bearer ${token}` };
  const deviceId = 'turn-browser-source', nativeId = 'turn-browser-session';
  const messages = Array.from({ length: 23 }, (_, turn) => [
    { role: 'user', text: `分页问题 ${turn}` },
    { role: 'assistant', phase: 'commentary', text: `检查进度 ${turn}` },
    { role: 'tool_call', name: 'read_file', text: `读取 ${turn}` },
    { role: 'tool_result', text: `结果 ${turn}` },
    { role: 'assistant', phase: 'final', text: `分页回答 ${turn}\n\n${'完整问答与工具记录一起加载。'.repeat(20)}` }
  ]).flat();
  expect((await request.post('/api/task-center', { headers, data: { action: 'heartbeat', deviceId, name: '轮次测试设备', agents: ['codex'], sessions: [{ nativeId, agent: 'codex', title: '按轮次加载回归', remoteHistory: { format: 2, offset: 0, total: messages.length, messages, sourcePartial: false, truncated: false } }] } })).ok()).toBeTruthy();
  const { sessions } = await (await request.get('/api/agent-sessions', { headers })).json() as { sessions: Array<{ id: string; deviceId: string }> };
  const id = sessions.find(session => session.deviceId === deviceId)!.id;
  await login(page);
  await page.goto(`/history/${id}`);
  await expect(page.getByText('已显示 10 / 23 轮问答')).toBeVisible();
  await expect(page.getByText('已显示 10 / 23 轮问答')).toBeInViewport();
  await expect(page.getByText('分页问题 13', { exact: true })).toHaveCount(1);
  await expect(page.getByText('分页问题 12', { exact: true })).toHaveCount(0);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/agent-sessions/${id}?turns=10&before=*`, async route => { await gate; await route.continue(); });
  const scroll = page.locator('.history-chat-scroll');
  await scroll.evaluate(element => { element.scrollTop = 0; });
  await expect(page.getByRole('button', { name: '正在加载更早的问答…' })).toBeVisible();
  const anchor = await page.getByText('分页问题 13', { exact: true }).boundingBox();
  release();
  await expect(page.getByText('已显示 20 / 23 轮问答')).toBeVisible();
  await expect(page.getByText('分页问题 3', { exact: true })).toHaveCount(1);
  await expect(page.getByText('分页问题 2', { exact: true })).toHaveCount(0);
  const after = await page.getByText('分页问题 13', { exact: true }).boundingBox();
  expect(Math.abs(after!.y - anchor!.y)).toBeLessThan(3);
  await scroll.evaluate(element => { element.scrollTop = 0; });
  await expect(page.getByText('已显示 23 / 23 轮问答')).toBeVisible();
  await expect(page.getByText('分页问题 0', { exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: '加载更早的 10 轮问答' })).toHaveCount(0);
});

test('semantic results work through task, defect and history search controls', async ({ page }) => {
  await login(page);
  const timestamp = '2026-10-01T00:00:00Z';
  const task = { id: 'semantic-task', title: '修复登录流程', content: '修复登录失败', status: 'ready', revision: 1, contextVersion: 1, sessionIds: [], events: [], createdAt: timestamp, updatedAt: timestamp };
  await page.route('**/api/bootstrap', async route => {
    const response = await route.fetch();
    await route.fulfill({ json: { ...await response.json(), search: { vectorEnabled: true },
      bugs: [{ id: 'semantic-bug', code: 'BUG-SEMANTIC', title: '登录异常', description: '无法进入系统' }] } });
  });
  await page.route('**/api/task-center', route => route.fulfill({ json: { tasks: [task], sessions: [], devices: [], executions: [], handoffs: [] } }));
  await page.route('**/api/search?*', route => {
    const scope = new URL(route.request().url()).searchParams.get('scope');
    return route.fulfill({ json: { ids: [scope === 'tasks' ? task.id : 'semantic-bug'], mode: 'hybrid' } });
  });
  await page.reload();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    if (width === 390) await page.getByRole('button', { name: '返回任务列表' }).click();
    const input = page.getByRole('textbox', { name: '搜索任务与会话' });
    await input.fill('身份认证');
    await expect(page.getByText('已包含语义相关结果')).toBeVisible();
    await page.getByRole('button', { name: /修复登录流程/ }).click();
    await expect(page.getByRole('heading', { name: task.title, exact: true })).toBeVisible();
    if (width === 390) await page.getByRole('button', { name: '返回任务列表' }).click();
    await input.clear();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  }
  await page.goto('/workbench');
  await page.getByRole('searchbox', { name: '搜索缺陷' }).fill('身份认证');
  await expect(page.getByText('已包含语义相关结果')).toBeVisible();
  await expect(page.getByRole('button', { name: /BUG-SEMANTIC/ })).toBeVisible();
  const session = { id: 'f'.repeat(64), title: '处理登录异常', agent: 'codex', agentLabel: 'Codex', cwd: '/repo', updatedAt: timestamp };
  await page.route('**/api/agent-sessions?*', route => {
    const searched = new URL(route.request().url()).searchParams.get('q') === '身份认证';
    return route.fulfill({ json: { sessions: searched ? [session] : [], total: searched ? 1 : 0, offset: 0, limit: 30, providers: [], workspaces: [], scope: 'all', search: { mode: 'hybrid' } } });
  });
  await page.goto('/history');
  await page.getByRole('textbox', { name: '搜索会话' }).fill('身份认证');
  await page.getByRole('button', { name: '刷新会话', exact: true }).click();
  await expect(page.getByText('共 1 个会话，关键词优先，包含语义相关结果')).toBeVisible();
  await expect(page.getByText('处理登录异常', { exact: true })).toBeVisible();
});
