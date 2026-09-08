# 自动 Bug 工作流工作台

这是一个支持多组织、多用户、RBAC 角色权限和 SQLite 数据库的轻量 Web 工作台，用于：

- 定时或手动拉取个人缺陷
- 选择缺陷并生成 Loop / IDE 分工明确的修复流水线
- 在独立流水线页面中预览、启动、停止并审核 Codex 任务
- 预留 PM 研发管理平台接口适配

## 运行

需要 **Node.js >= 22.16**。数据库使用 Node.js 内置 `node:sqlite`，无需安装数据库服务或额外 npm 依赖。

```bash
cp .env.example .env
# 编辑 .env，配置自己的 PM 地址、凭据、产品线和工作目录
npm start
```

默认地址：`http://localhost:4173`

启动时读取项目根目录的 `.env`，初始化 `.workflow-data/workflow.sqlite`，并自动升级数据库结构。默认组织 ID 为 `default`。

**从共享令牌版本升级：**重启服务，在登录页展开“首次使用？初始化组织所有者”，输入原组织令牌，设置所有者的用户名、显示名称和密码。默认组织的原令牌在 `.workflow-data/default-token`，或首次创建时设置的 `DEFAULT_TENANT_TOKEN` 中。初始化不会改变缺陷、流水线、配置或执行记录。

所有者创建成功后，使用“组织 ID + 用户名 + 密码”登录，在“组织成员”页面创建其他用户并分配角色。原组织令牌仅用于首次初始化，不能调用任何业务 API；初始化完成后即使轮换组织令牌，也不能重新初始化或绕过成员权限。

页面“对接配置”、分配人员、缺陷、流水线和执行记录写入数据库。组织内的成员共享业务数据，通过角色控制操作权限。现有 `user_key` 是 PM 经办人的数据分组，**不等于登录账号**；修改经办人筛选会影响组织当前工作台，只有管理员和所有者有权修改。每个组织拥有独立的定时任务、运行进程、分配任务和 PM/AI 凭据。重启后执行中的流水线标记为中断，定时任务默认暂停，需要手动重新启用。

## 用户与角色权限

每个组织可创建多个独立用户，同一用户名可存在于不同组织，登录时必须提供组织 ID。用户名为 3–80 位字母、数字、点、下划线、短横线或 `@`，不区分大小写。密码为 12–128 个字符，使用随机盐和 scrypt 保存摘要，不存储或返回明文密码。

| 角色 | 查看数据 | 同步、分配、生成/启停流水线 | 完成节点、审核、发布关闭 | 配置与分配规则 | 成员管理与审计 |
| --- | --- | --- | --- | --- | --- |
| 组织所有者 `owner` | ✓ | ✓ | ✓ | ✓ | 管理所有角色 |
| 管理员 `admin` | ✓ | ✓ | ✓ | ✓ | 仅管理操作员、只读成员；可查看审计 |
| 操作员 `operator` | ✓ | ✓ | — | — | — |
| 只读成员 `viewer` | ✓ | — | — | — | — |

这是四个内置角色的 RBAC；当前不包含自定义角色、SSO、邮件邀请或跨组织共享账号。所有权限由服务端逐请求校验，前端同时隐藏无权操作的入口。组织必须至少保留一位启用的所有者；如需转移所有权，先创建或提升另一位所有者，再调整原所有者的角色。

“组织成员”支持创建用户、修改名称和角色、停用/启用账号、重置密码。“我的账号”支持验证当前密码后设置新密码。角色调整从下一次请求立即生效；停用、重置密码、修改自己的密码会撤销该用户全部登录会话，重新启用不会恢复旧会话。退出登录会撤销当前会话。已启动的后台任务继续执行，并保留发起人信息。

登录返回随机会话令牌，数据库只保存其 SHA-256 摘要，有效期为 24 小时。浏览器保存在当前标签页的 `sessionStorage` 中；到期需重新登录。登录和密码相关操作有请求频率及并发限制。成员变更、密码重置、登录退出、业务写入请求和拒绝的业务访问记入组织审计，管理员可查看最近 200 条，审计不包含密码或会话令牌。

## 组织管理与账号恢复

在服务器本地执行：

```bash
npm run tenant -- add team-a 团队A
npm run tenant -- list
npm run tenant -- rotate team-a
npm run tenant -- users team-a
npm run tenant -- reset-password team-a 用户名
```

创建和轮换命令只显示一次**组织初始化令牌**；轮换后旧初始化令牌失效，已建立的成员会话不受影响。`reset-password` 供服务器管理员恢复账号，终端只显示一次随机新密码并撤销目标用户所有会话，操作写入审计。组织尚未初始化时，使用登录页初始化流程创建所有者。

为新增租户创建 `.workflow-data/tenants/team-a.env`：

```env
PM_BASE_URL=https://pm.example.com
PM_ACCESS_KEY=团队A的AK
PM_ACCESS_SECRET=团队A的SK
PM_LINE_ID=团队A产品线
OPENAI_API_KEY=团队A的AI密钥
CODEX_WORKSPACE_DIR=/srv/bugflow/repos/team-a
ENABLE_AUTO_ASSIGNMENT=false
```

新增租户不会继承默认团队的配置或凭据。默认团队兼容根目录 `.env`，也可用 `default.env` 覆盖。修改租户环境文件后重启服务。IDE 执行目录应使用独立的仓库副本；服务拒绝不同租户使用相同或相互嵌套的目录。在多租户模式下，该路径由管理员通过环境文件管理。未配置工作目录的租户可以管理缺陷和配置，配置目录后才可生成和执行 IDE 任务。

除 `POST /api/auth/login` 外，API 均要求 Bearer 认证。初始化接口 `GET/POST /api/auth/setup` 仅接受组织初始化令牌；所有业务接口仅接受**成员登录会话令牌**。服务端根据会话确定组织和用户，拒绝伪造的 `X-Tenant-Id`，不接受业务请求体中的 `tenantId` 或 `role` 提权。

主要接口：

- `POST /api/auth/login`：`{ tenantId, username, password }`，返回会话令牌、当前用户及权限。
- `GET /api/auth/session` / `POST /api/auth/logout`：当前会话与退出。
- `PUT /api/auth/password`：`{ currentPassword, password }`，修改自己的密码并撤销全部会话。
- `GET/POST /api/organization/members`：列出或创建成员；创建参数为 `{ username, displayName, password, role }`。
- `PATCH /api/organization/members/:id`：`{ displayName?, role?, enabled? }`。
- `PUT /api/organization/members/:id/password`：`{ password }`，重置成员密码。
- `GET /api/organization/roles` / `GET /api/organization/audit`：角色权限与审计记录。

```bash
curl -H "Authorization: Bearer $SESSION_TOKEN" http://localhost:4173/api/bootstrap
```

当前部署方式是**单 Node.js 服务进程 + SQLite**，适合内部团队工作台；租户隔离覆盖应用数据与运行状态。IDE CLI 仍以服务器系统用户运行，这不是面向互不信任客户的操作系统沙箱。外部访问应由 HTTPS 反向代理承接；跨主机、多实例部署需要另行接入共享数据库与任务队列。

## 数据迁移与备份

首次启动自动将旧 `.workflow-config.json`、`.assignment-people.json` 和 `.workflow-data/users/<用户>/state.json` 导入默认团队，同时兼容旧版本实际生成的 `.workflow-data/users/users/<用户>/state.json`。导入使用数据库事务并记录完成标记，重启不会重复覆盖；原 JSON 文件保留。损坏或重复的用户目录会导致迁移报错，不会静默丢弃数据。

也可以在启动前执行迁移，或导入到已创建的空租户：

```bash
npm run tenant -- migrate
npm run tenant -- migrate team-a
```

数据库位置通过 `DATABASE_PATH` 设置，租户凭据目录通过 `TENANT_ENV_DIR` 设置。SQL 表结构位于 `migrations/001_initial.sql` 和 `migrations/002_rbac.sql`，版本记录在 SQLite `user_version`（当前为 2）。`tenants` 保存租户和令牌摘要，`tenant_settings` 保存配置和人员，`user_states` / `workflow_items` 用组合主键及外键保存租户内的业务数据；一次状态保存整体提交或回滚。`organization_users` 保存组织内账号与角色，`user_sessions` 保存用户会话，`audit_events` 保存组织审计记录。

备份时先停止服务，再复制 SQLite 文件及租户环境文件、默认令牌文件；IDE 任务包和附件仍在各租户工作目录下，需要另外备份。恢复时将备份放回配置的位置再启动。不要让多个服务进程同时使用同一个数据库文件，因为后台执行状态保存在各进程内存中。

运行 `npm test` 可验证业务逻辑、数据库事务与迁移、组织认证、角色越权、跨组织成员访问、所有者保护、会话撤销、并发权限变更、并发同步和重启恢复。

## 密钥

不要把 AK/SK 写进前端或提交到仓库。服务端从环境变量读取：

```bash
PM_ACCESS_KEY=你的AK PM_ACCESS_SECRET=你的SK npm start
```

当前原型只使用真实 PM 数据。配置：

```bash
PM_MODE=pm PM_LINE_ID=产品线ID PM_FILTER_ID=筛选器ID npm start
```

## 筛选

可在 `.env` 或页面“对接配置”里设置：

```env
PM_ASSIGNEE=
```

`PM_ASSIGNEE` 是缺陷经办人，支持填写员工号、邮箱或人员 ID。填了经办人后，服务端会走缺陷分页接口并追加 `assignee` 条件；为空时优先使用 `PM_FILTER_ID` 对应的 PM 筛选器。

如果只想拉当前个人 Token 对应人员的数据，设置：

```env
PM_SELF_ONLY=true
```

默认按文档示例使用：

```env
PM_SELF_ONLY=false
```

缺陷普通分页默认拉 300 条一页、最多 10 页：

```env
PM_PAGE_SIZE=300
PM_MAX_PAGES=10
```

PM 网关限制 5 秒内最多 5 次请求，因此分页请求默认间隔 1200ms；如果仍触发限流，会等待 5200ms 后重试一次：

```env
PM_REQUEST_DELAY_MS=1200
PM_RATE_LIMIT_RETRY_MS=5200
```

页面“立即拉取”会做全量查询；定时任务才会使用更新时间做增量查询，避免手动刷新后只剩最近更新的少量缺陷。

## PM 接口映射

当前 PM 适配器使用以下接口（请根据你部署的平台确认接口兼容性）：

- 个人 Token 推荐认证：请求头 `X-Access-Key` / `X-Access-Secret`
- 缺陷分页查询：`POST /tm/oauth/rest/v1/bip/api/base/page`
- 缺陷筛选器分页：`POST /tm/oauth/rest/v1/bip/api/base/pageByFilter/{filterId}`
- 附件查询：`GET /tm/oauth/rest/v1/bip/api/base/attachments/{aid}`
- 流程可用操作：`GET /tm/oauth/rest/v1/bip/api/workflow/operations`
- 流程流转：`POST /tm/oauth/rest/v1/bip/api/workflow/processConvert`

打开 PM 联调模式并配置环境变量后，`/api/sync` 会尝试调用缺陷分页或筛选器接口。

## 交给 IDE Agent（Codex / Claude Code）

IDE 执行路径可以在 `.env` 或页面“对接配置”里设置。默认执行器为 Codex，也可切换为 Claude Code：

```env
IDE_EXECUTOR=codex
CODEX_WORKSPACE_DIR=/srv/bugflow/repos/my-project
CODEX_MODEL=gpt-5.6-sol
CODEX_REASONING_EFFORT=medium
CLAUDE_MODEL=claude-opus-4-8
CODEX_BASE_BRANCH=main
ENABLE_BUG_INFO_COMPLETION=true
ALLOW_SKIP_INFO_COMPLETION=true
ENABLE_AI_ROUTING=true
ENABLE_AI_ASSIGNMENT=true
ENABLE_AUTO_ASSIGNMENT=false
AI_ASSIGNMENT_MODEL=gpt-5.4-mini
OPENAI_API_KEY=你的OpenAI API Key
OPENAI_BASE_URL=https://api.openai.com/v1
AI_ROUTING_MODEL=gpt-5.6-sol
AI_ROUTING_TIMEOUT_MS=30000
ALLOWED_AUTO_FIX_PRIORITIES=P2,P3
REQUIRE_VERIFICATION_REPORT=true
REQUIRE_REGRESSION_TEST=false
REQUIRE_HUMAN_REVIEW=true
```

- `IDE_EXECUTOR` 支持 `codex` 或 `claude`，也可在“执行流水线”页面每次生成流水线时单独选择。
- Codex 使用 `codex exec`；Claude Code 使用 `claude --bare -p` 非交互模式，需本机已安装 `claude` CLI 并配置 `ANTHROPIC_API_KEY`。
- GPT 模型列表支持 `gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`、`gpt-5.5`、`gpt-5.4` 和 `gpt-5.4-mini`。

`CODEX_REASONING_EFFORT` 支持 `low / medium / high / xhigh`，对应页面里的低 / 中 / 高 / 超高。
`ENABLE_AI_ROUTING=true` 时，服务端会使用 `OPENAI_API_KEY` 调用 `AI_ROUTING_MODEL` 做 Bug 类型和优先级分类；如果模型调用失败，会在路由结果中标记 `local-rule-fallback` 并使用本地规则兜底。
`ENABLE_AI_ASSIGNMENT=true` 时，服务端会使用 `OPENAI_API_KEY` 调用 `AI_ASSIGNMENT_MODEL`（默认 `gpt-5.4-mini`）生成“推荐分配人”，但不会自动修改 PM 经办人；仅待处理和处理中的缺陷会生成分配建议，需要在页面人工点击“分配给推荐人”后才会调用 PM `base/move` 接口。当前分配场景只向 PM 传 `assignee`。
`ENABLE_AUTO_ASSIGNMENT=true` 时，AI 分配建议生成完毕后会自动批量调用 PM `base/move`；关闭时可在工作台使用“一键分配”批量确认所有待分配建议。

选择一条缺陷后进入“执行流水线”，可以先生成流水线并预览任务包、节点和命令，再到 IDE 自主节点点击“启动 IDE 任务”：

- 生成人工流水线：生成任务包和节点，不立即启动 IDE Agent
- 生成自动流水线：生成自动模式任务包和节点，不立即启动 IDE Agent；确认后由 IDE 自主节点启动对应 CLI

创建流水线后，服务端会：

- 尽量补齐该缺陷的附件信息
- 拉取后根据已配置的人员职责为待处理/处理中的 Bug 生成 AI 分配建议，人工确认后通过 `POST /tm/oauth/rest/v1/bip/api/base/move` 分配
- 按标准 Bug 模板规范化缺陷信息，并标出缺失字段
- 调用模型对缺陷做路由分类，判断 Bug 类型、优先级、是否适合 IDE 自主修复
- 生成结构化 Markdown 任务包
- 写入 `${CODEX_WORKSPACE_DIR}/.codex/tasks/<tenant>/*.md`
- 启动任务时从配置的主分支最新代码创建独立 Bug 分支 `codex/<tenant>/bug/<缺陷编码>`
- 由 IDE Agent 完成复现定位、修复方案、编码修复、自动化测试和验证报告
- IDE 完成后自动提交 Bug 分支改动，并合并到个人当天验证分支 `codex/<tenant>/daily/<person>/<yyyyMMdd>`
- 如果合并到当天验证分支出现冲突，服务端会生成冲突处理任务并再次启动 Codex 解决冲突、完成 merge commit
- IDE 完成后停在 Loop 人工 Review 节点，人工通过后才能进入发布与关闭工单
- 在页面展示执行进程、日志、退出码、路由结果、验证报告、人审结果和发布关闭状态

每个流水线节点都可以单独点击查看详情和当前输出。信息补全、路由分类、人工 Review、发布关闭由 Loop 控制；复现定位、修复方案、编码修复、自动化测试和验证报告由 IDE Agent 执行。

新 Bug 分支不存在时，服务端会优先执行 `git fetch origin <CODEX_BASE_BRANCH>`，再从 `origin/<CODEX_BASE_BRANCH>` 创建分支；如果没有 `origin`，则从本地主分支创建。当天验证分支不存在时也按同样主分支创建。目标仓库如果不在目标分支且存在未提交变更，服务端会拒绝启动，避免把已有改动带到错误分支。运行中的任务可以在执行节点里点击“停止任务”，服务端会先发送 `SIGTERM`，5 秒后仍未退出则发送 `SIGKILL`。

## Agent 历史会话

侧边栏“Agent 历史会话”支持 Codex 和 Claude Code 的全部本地工作区历史记录，包含 Agent 与工作区筛选、标题/会话 ID/目录/模型/分支搜索、按更新时间排序、分页、会话详情及可折叠的工具调用与结果。列表每页 30 条，详情每次加载 100 条。点击“搜索 / 刷新”重新检查文件变化；不会自动执行或恢复历史任务。

默认组织自动读取服务器用户的 `${CODEX_HOME:-~/.codex}/sessions`、`archived_sessions` 和 `${CLAUDE_CONFIG_DIR:-~/.claude}/projects`。也可在根 `.env` 或组织环境文件中指定：

```env
IDE_HISTORY_CODEX_DIR=/srv/agent-data/codex/sessions
IDE_HISTORY_CLAUDE_DIR=/srv/agent-data/claude/projects
```

显式设置会替换对应 Agent 的默认扫描目录，支持递归读取 `.jsonl`。其他组织必须显式配置历史目录，不会自动扫描服务器用户的历史。修改环境文件后重启服务。

默认读取该组织历史数据源中的**全部工作区**，不再受 `CODEX_WORKSPACE_DIR` 限制。页面提供“全部工作区”及各工作区的精确筛选，选项包含完整路径和会话数量；会话涉及多个目录时可通过任一目录筛选，缺少 `cwd` 的记录归入“未知工作区”。工作区目录从日志元数据读取，不作为新的文件扫描入口；独立 worktree 也会显示。

所有登录成员（含只读成员）共享该组织已配置历史数据源的可见范围。默认组织读取本机默认 Agent 历史目录；其他组织仍必须显式配置自己的历史数据源，不会继承默认组织来源。需要沿用旧版工作目录限制时，在组织环境文件设置 `IDE_HISTORY_SCOPE=workspace`；默认是 `all`。部署方应为不同组织配置各自的历史目录。服务不遍历来源目录内的符号链接，不接受客户端指定文件路径。这里只读取运行服务器上的文件；远程机器和云端会话需要后续适配器接入。

历史页面采用 Codex 风格的灰白布局、紧凑会话列表、右侧对话阅读区和可折叠工作过程。用户消息以灰色气泡显示，助手回复支持安全的 Markdown 子集（段落、标题、列表、加粗、行内代码、代码块和 HTTP/HTTPS 链接），原始 HTML 不执行，Markdown 中的外部图片不加载；日志内嵌图片作为独立附件展示。会话信息默认折叠；“会话跨度”表示首末记录的时间差，不是 Agent 的实际运行耗时。

这是历史记录视图：只有日志明确记录结束、中断或错误时才展示相应状态，否则显示“运行状态未知”，不根据文件更新时间猜测任务是否仍在运行。Codex 同时产生的事件与消息副本会去重；已知插件推荐、环境上下文与 AGENTS 指令包从用户消息中移除，包外真实用户文本保留；过滤发生在标题提取和计数之前。系统角色和推理数据不展示。Codex input_image 与 Claude image 中保存的 PNG/JPEG/GIF/WebP 内嵌图片会在详情显示（单张最多约 12 MiB）；远程链接、未保存的图片和不支持的格式提示无法预览。损坏行、未写完行会跳过并提示；单文件最多读取前 64 MiB，详情最多展示前 10,000 条，每条文本最多显示 24,000 字符。未知记录类型会忽略，CLI 格式变化可能需要更新适配器。扫描结果缓存按文件大小及修改时间失效，详情按需读取，不修改历史文件。

接口（均需成员 Bearer 认证）：

- `GET /api/agent-sessions?agent=codex&workspace=工作区完整路径&q=关键词&offset=0&limit=30`：返回 `providers`（来源状态）、`sessions`、`total`、`offset`、`limit` 、当前筛选 `workspace`、工作区选项 `workspaces: [{ path, count }]` 和数据范围 `scope`（`all` / `workspace`）。`workspace=__unknown__` 筛选未知工作区，留空表示全部。
- `GET /api/agent-sessions/:id?offset=0&limit=100`：返回 `session`、`messages` 和分页信息。`:id` 使用列表返回的不透明 ID，不接受文件路径。

扩展实现位于 `src/agentHistory/`。新增 Agent 时，实现 `{ id, label, roots(environment, tenantId), decode(row) }` 并加入 `defaultHistoryAdapters`；`decode` 返回元数据（如 `cwd`、`id`、`title`、`model`、`branch`、`status`）及标准 `entries: [{ role, text, timestamp, name?, callId? }]`。角色为 `user`、`assistant`、`tool_call` 或 `tool_result`。新适配器应提供绝对 `cwd`；缺失时归入未知工作区，所有路径校验、索引、缓存、搜索、分页、权限和页面复用现有实现。非 JSONL 数据源可在服务层另加读取器，保持 HTTP 返回结构不变。历史适配器独立于 CLI 执行器，增加历史支持不会自动获得执行能力。

## 开源发布与数据边界

仓库仅包含源码、数据库建表迁移、测试代码及文档；SQL 迁移不包含业务记录，测试使用虚构数据。默认人员列表为空，请在组织配置中添加自己的分配人员。示例域名与路径需要替换成实际配置。

真实凭据、人员信息、业务配置、SQLite 数据库、缺陷与执行记录、Agent 历史、日志、截图和附件均不纳入版本控制。本地数据保留在忽略目录中；不要使用 `git add -f` 强行提交。添加新的文件或目录前，先检查内容及 `git diff --cached`。

本项目采用 MIT 许可证，见 [LICENSE](LICENSE)。
