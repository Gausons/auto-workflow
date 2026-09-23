# Web 前端技术选型

状态：已采纳，渐进迁移中  
日期：2026-09-23  
范围：仅浏览器 Web 应用；不讨论桌面应用、移动应用或跨端 UI。

## 结论

采用 **React + TypeScript + Vite** 渐进替换当前原生 DOM 前端，保持纯浏览器端渲染的 SPA，并继续复用现有 Node.js HTTP 服务。

| 层次 | 选择 | 用途 |
| --- | --- | --- |
| UI | React | 建立组件边界，替代字符串模板和直接 DOM 操作 |
| 构建 | Vite | 开发服务、模块构建、代码分割和带指纹的生产资源 |
| 路由 | React Router（Data Mode） | 页面路由、懒加载、错误边界和 URL 状态 |
| 服务端状态 | TanStack Query | 查询缓存、状态感知轮询、失焦恢复和 mutation 状态 |
| 本地状态 | React state / reducer / context | 表单草稿、弹窗、筛选和少量应用级上下文 |
| 样式 | CSS Modules + CSS Variables | 复用现有视觉语言并隔离组件样式 |
| 测试 | Vitest + Testing Library + Playwright | 纯逻辑、组件行为和关键浏览器流程 |
| 包管理 | pnpm | 延续仓库现有约定，不引入 npm 或 yarn |

不采用 SSR，不引入移动端、桌面端或 PWA 专用框架，也不为假设中的其他运行平台预设工程结构。

当前实施进度：Vite 内容哈希构建、manifest 静态资源加载、React/TanStack Query 基础入口、登录、组织初始化、账号密码修改、组织成员和审计记录已落地；任务、会话、缺陷和其余设置页面继续沿用兼容层，按下述阶段迁移。

## 现状与问题

当前浏览器端约 3,900 行，由静态 HTML、全局 CSS 和多个直接操作 DOM 的 TypeScript 模块组成：

- `public/app.ts` 同时承担认证、hash 路由、请求、全局状态和多个页面；
- 页面大量依赖 `innerHTML`、全局选择器和事件委托，局部更新和组件测试困难；
- `public/taskCenter.ts` 同时包含数据加载、轮询、渲染、表单和执行控制；
- API 请求与 token 处理集中在页面代码中，错误处理和重试策略不易统一；
- `public/styles.css` 已超过 1,700 行，样式作用域和删除验证成本持续增加；
- `server.ts` 手工枚举静态资源，不能直接承接 Vite 的资源清单和内容 hash。

当前规模仍适合渐进迁移。React 支持接入现有项目，Vite 适合浏览器端渲染的 SPA，不需要把现有服务端改成元框架或 SSR 运行时。

## 工程结构

迁移完成后的建议结构：

```text
src/                              现有服务端领域逻辑
server.ts                         HTTP、认证、RBAC 和静态资源边界

web/
  index.html
  src/
    app/                          路由、Provider、应用外壳
    features/                     tasks、history、workbench、settings、auth
    components/                   稳定的通用 Web 组件
    api/                          API client、query keys、DTO
    styles/                       tokens 和全局基础样式
    test/                         浏览器测试辅助代码
```

不需要为单个 Web 应用建立 `apps/`、`packages/` 或 pnpm workspace。只有未来出现第二个真实可发布包时再调整为 workspace，避免提前增加目录和构建复杂度。

## 具体约定

### React

- 以业务功能组织代码，不按 `components/hooks/utils` 做全局堆放；
- 页面只组合 feature，业务数据转换放在纯函数或自定义 hook 中；
- 避免把现有全局状态原样搬进一个巨大 Context；
- 不通过 `dangerouslySetInnerHTML` 复制当前字符串模板；Markdown 等必要 HTML 必须经过现有安全渲染边界；
- 保留中文用户文案以及现有认证、RBAC、多租户、revision 和幂等语义。

### 路由

使用 React Router Data Mode，但只使用浏览器端能力，不引入 React Router 的服务端运行时。

迁移期保留 `#tasks`、`#history/:id` 等现有地址，确保书签和测试不立即失效。全部业务页面迁移后改用普通路径：

```text
/tasks
/tasks/new
/inbox
/workbench
/history
/history/:sessionId
/settings/:section
```

切换普通路径时，`server.ts` 需要为非 API、非静态资源的 GET/HEAD 请求返回 Web 入口文件，同时严格排除路径越界和不存在的带扩展名资源。旧 hash 地址保留一次兼容跳转。

### 数据与状态

TanStack Query 只管理服务端状态：bootstrap、任务、会话、成员、配置和执行状态。

- query key 由各 feature 集中定义；
- 执行中的任务按状态设置轮询间隔，页面隐藏或任务结束后停止轮询；
- 查询可对明确的瞬时失败进行有限重试；
- 创建任务、启动 Agent、回复审批、停止执行和切换分支等 mutation 默认不自动重试；
- mutation 继续携带 requestId、revision 等服务端幂等或并发字段；
- 未知执行结果必须进入核对流程，不能由 Query 自动再次提交。

本地 UI 状态优先使用组件 state、reducer 和 URL search params。登录用户、权限和租户信息可以放在轻量 Auth Context。当前不引入 Redux、Zustand 等全局状态库；只有出现跨多个不相邻页面、无法由 URL 或查询缓存表达的复杂前端状态时再评估。

### API 层

建立唯一的 `web/src/api/client.ts`，负责：

- 从统一位置读取 `sessionStorage` token；
- 添加 Authorization 和 JSON headers；
- 解析结构化错误并处理 401；
- 支持 AbortSignal，避免路由切换后的过期响应覆盖新状态；
- 区分 query 与 mutation 的重试策略；
- 保持现有同源 `/api` 请求，不额外引入 CORS。

DTO 从页面文件移动到 `web/src/api/types.ts` 或按 feature 就近维护。共享 TypeScript 类型不能替代服务端输入校验；服务端仍是认证、权限、租户隔离和数据有效性的唯一可信边界。

中期可为稳定接口补 OpenAPI 或等价契约生成，但不把它作为 React 迁移的前置阻塞项。

### 样式与组件

先从现有 `styles.css` 提取颜色、间距、圆角、字体和状态颜色为 CSS Variables，再按迁移页面拆为 CSS Modules。

通用组件只覆盖已经稳定复用的原语，例如：

- Button、Input、Select、Textarea；
- Dialog、Toast、Tabs；
- StatusTag、EmptyState、LoadingState；
- PageHeader、SplitPane。

暂不引入 Tailwind 或大型 UI 组件库。当前已经有完整视觉风格，立即替换样式体系会扩大迁移范围。若后续确实需要复杂无障碍组件，可以针对 Dialog、Popover、Combobox 等少数场景评估 headless 组件库。

### 测试

保留现有 `node:test` 服务端测试，并新增三层 Web 测试：

1. Vitest：状态转换、时间线归并、权限呈现和格式化等纯函数；
2. Testing Library：组件交互、表单错误、加载态和权限态；
3. Playwright：登录、任务创建、Agent 执行、审批回复、会话续聊和只读成员限制。

组件测试关注可见行为，不断言 React 内部实现。关键 E2E 必须覆盖失败、未知结果和重复提交保护，而不只覆盖成功路径。

## 未选择的方案

| 方案 | 不作为主方案的原因 |
| --- | --- |
| 继续扩展原生 DOM | 依赖最少，但状态、模板和事件耦合已经影响维护与测试 |
| Vue | 同样可满足需求，但相对 React 没有足以抵消生态、招聘和测试工具差异的项目特定优势 |
| Svelte | 代码简洁，但团队生态和长期大型工作台经验通常少于 React，当前没有必须选择它的性能约束 |
| Next.js | 当前是登录后的内部 SPA，SEO、静态生成和 React Server Components 收益有限，却会扩大部署与认证边界 |
| React Router SSR | 与 Next.js 类似；现有 Node HTTP 服务无需增加第二套服务端渲染生命周期 |
| Tailwind | 会导致现有 1,700 多行 CSS 在框架迁移期间同时重写，收益与风险不匹配 |
| Redux / Zustand | 当前绝大部分状态是服务端状态或局部 UI 状态，先用 Query 与 React 内建状态即可 |

## 渐进迁移计划

### 阶段 0：构建和测试基线

- 引入 Vite、Vitest 和最小 React 入口；
- 为登录、任务创建、执行、审批、续聊和 RBAC 建立 Playwright 基线；
- 改造静态资源服务，使其支持 Vite manifest、内容 hash、正确 MIME 和路径越界防护；
- 保持现有页面为默认入口，新入口仅用于迁移验证。

完成标准：生产构建可由现有 `server.ts` 提供，旧 UI 和既有测试无行为变化。

### 阶段 1：外壳与低风险页面

- 迁移应用外壳、错误边界、认证状态和路由适配；
- 先迁移登录、账户设置和成员管理；
- 提取 CSS Variables 和基础组件，不做视觉重设计。

完成标准：新旧页面在同一构建中工作，现有 hash 链接和权限展示兼容。

### 阶段 2：核心页面

- 按“缺陷工作台 → 历史会话 → 任务中心”的顺序迁移；
- 将时间线、Markdown、Agent 运行配置和状态映射拆为可测试模块；
- 用 TanStack Query 逐项替换手写请求与轮询；
- 每个页面迁移后删除其旧写路径，避免长期双实现。

完成标准：关键 Playwright 用例通过，业务页面不再依赖字符串拼接和全局事件委托。

### 阶段 3：切换和清理

- 将 React Web 应用切换为唯一入口；
- 改用普通 URL 和 SPA fallback，保留旧 hash 地址兼容跳转；
- 删除旧 DOM 模块、失效 CSS 和手工静态资源枚举；
- 运行 `pnpm typecheck`、完整 `pnpm test`、Web 生产构建和关键 E2E。

不要在一次提交中同时完成目录迁移、框架替换、视觉重做和 API 重构。

## 验收标准

- 所有现有功能、RBAC 和多租户行为保持一致；
- 登录、任务、会话、审批和设置页面均有明确加载态、空态和失败态；
- Agent 命令不会因自动重试或重复点击而重复执行；
- 页面切换不会产生过期请求覆盖、重复轮询或未释放计时器；
- 构建产物不手工提交，`pnpm build` 可重复生成；
- `pnpm typecheck`、完整 `pnpm test` 和约定的 Web E2E 全部通过；
- 旧 hash 链接在兼容期内仍能打开对应页面。

## 参考资料

- [React：在现有项目中渐进采用](https://react.dev/learn/installation)
- [React：从零构建应用时的工具建议](https://react.dev/learn/build-a-react-app-from-scratch)
- [React Router Data Mode](https://reactrouter.com/start/data/custom)
- [React Router 路由对象与错误边界](https://reactrouter.com/start/data/route-object)
- [TanStack Query 文档](https://tanstack.com/query/latest/docs/framework/react/overview)
- [Vite 后端集成与 manifest](https://vite.dev/guide/backend-integration.html)
