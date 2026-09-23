# Agent 任务工作台

面向研发团队的缺陷与 Agent 任务工作台：从 Jira 同步问题、生成分配建议，把缺陷转换成可维护的任务上下文，再交给本机或远端的 Codex、Claude Code 等 ACP Agent 执行。

> 当前版本不再使用“执行流水线”。缺陷会直接生成任务中心任务，不会创建中间流水线、节点或任务包。

## 功能概览

- **缺陷工作台**：手动或定时同步 Jira，查看缺陷详情与附件。
- **智能分配**：根据候选人员和职责生成 AI 经办人建议，可选择人工确认或自动分配。
- **任务中心**：维护目标、约束、结论、下一步、文件与版本；同一缺陷只生成一个任务。
- **Agent 执行**：从任务直接启动 ACP Agent，处理确认与提问，停止或核对执行状态。
- **会话交付**：汇总 Codex、Claude Code 的本地或远端会话，支持接续、分支和引用。
- **团队协作**：提供组织、成员、角色、审计和多租户数据隔离。

## 工作流程

```mermaid
flowchart LR
  Jira[Jira 缺陷] --> Sync[同步与分配建议]
  Sync --> Bugs[缺陷工作台]
  Bugs -->|生成任务| Tasks[任务中心]
  Tasks --> Agent[本机或远端 Agent]
  Agent --> Sessions[会话与执行状态]
  Sessions --> Tasks
```

从缺陷详情生成任务时，服务端会：

1. 读取缺陷字段和附件元数据。
2. 将缺陷编码、标题、状态、优先级、描述、复现步骤、预期及实际结果写入任务上下文。
3. 将附件名称和链接写入“文件与版本”。
4. 保存缺陷来源；重复生成时直接打开已有任务。

任务生成后不会自动执行。执行目标、Agent、模型、思考强度和工作目录均在任务中心选择。

## 快速开始

### 环境要求

- Node.js 22.16 或更高版本
- pnpm
- Jira Cloud 凭据（同步 Jira 时需要）
- Codex 或 Claude Code 对应的 ACP 适配器（执行 Agent 时需要）

### 1. 安装并启动

```bash
cp .env.example .env
pnpm install
pnpm dev
```

默认监听 [http://127.0.0.1:4173](http://127.0.0.1:4173)。端口被占用时，启动脚本会先结束占用 `4173` 端口的旧进程。

### 2. 初始化组织所有者

首次启动会自动创建 ID 为 `default` 的组织。打开登录页，展开“首次使用？初始化组织所有者”，使用初始化令牌创建首位所有者。

令牌来源：

- `.env` 中设置了 `DEFAULT_TENANT_TOKEN`：使用该值；
- 未设置：服务启动后从 `.workflow-data/default-token` 读取自动生成的令牌。

```bash
cat .workflow-data/default-token
```

初始化完成后，所有成员都使用各自的用户名和密码登录，初始化令牌不能再次用于登录。

### 3. 配置 Jira

编辑 `.env`，至少填写：

```dotenv
ISSUE_PROVIDER=jira
JIRA_BASE_URL=https://your-team.atlassian.net
JIRA_EMAIL=you@example.com
JIRA_API_TOKEN=your-api-token
JIRA_JQL=project = DEMO
CODEX_WORKSPACE_DIR=/absolute/path/to/your/repository
```

重启服务后，在“缺陷工作台”点击“立即拉取”。JQL 只填写过滤条件，排序由适配器统一添加。

也可以用 `JIRA_ACCESS_TOKEN` 进行 Bearer 认证；设置后它会优先于邮箱和 API Token。服务端凭据不会发送到浏览器。

## 配置说明

完整示例见 [`.env.example`](./.env.example)。根目录 `.env` 是默认组织的配置，修改环境文件后需要重启服务。

### 服务与存储

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | HTTP 监听地址 |
| `PORT` | `4173` | HTTP 监听端口 |
| `DATABASE_PATH` | `.workflow-data/workflow.sqlite` | SQLite 数据库路径 |
| `TENANT_ENV_DIR` | `.workflow-data/tenants` | 各组织独立环境文件目录 |
| `DEFAULT_TENANT_TOKEN` | 自动生成 | 默认组织的首次初始化令牌，至少 32 个字符 |
| `CODEX_WORKSPACE_DIR` | 项目根目录 | 默认 Agent 工作目录 |

如需通过局域网或反向代理访问，可设置 `HOST=0.0.0.0`。请在可信网络中部署，并在对外开放时配置 HTTPS、访问控制和备份策略。

### Jira

| 变量 | 说明 |
| --- | --- |
| `JIRA_BASE_URL` | Jira Cloud 地址 |
| `JIRA_SITE_URL` | 可选；OAuth 网关地址与站点地址不同时，用于生成问题链接 |
| `JIRA_EMAIL` / `JIRA_API_TOKEN` | Basic 认证凭据 |
| `JIRA_ACCESS_TOKEN` | 可选；Bearer Token，优先使用 |
| `JIRA_JQL` | 缺陷筛选条件 |
| `JIRA_PAGE_SIZE` | 单页数量，默认 `100` |
| `JIRA_MAX_PAGES` | 最大拉取页数，默认 `50` |
| `JIRA_TIMEOUT_MS` | 请求超时，默认 `30000` 毫秒 |
| `JIRA_PRIORITY_MAP` | 可选的 JSON 优先级映射，如 `{"Critical":"P0","Normal":"P2"}` |

### AI 分配建议

```dotenv
ENABLE_AI_ASSIGNMENT=true
ENABLE_AUTO_ASSIGNMENT=false
AI_ASSIGNMENT_MODEL=gpt-5.4-mini
OPENAI_API_KEY=
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_TIMEOUT_MS=30000
```

在“设置 → 分配规则”中维护候选人员及职责。`ENABLE_AI_ASSIGNMENT` 只生成建议；只有开启 `ENABLE_AUTO_ASSIGNMENT` 后，系统才会调用问题数据源自动修改经办人。

同步间隔和定时同步开关可在“设置 → 对接配置”中管理。定时开关属于当前运行状态，服务重启后默认关闭。

### Agent 与历史会话

任务中心默认探测 Codex 和 Claude Code 的 ACP 适配器：

```dotenv
ACP_ENABLED=true
ACP_CODEX_EXECUTABLE=
ACP_CODEX_ARGS=[]
ACP_CLAUDE_EXECUTABLE=
ACP_CLAUDE_ARGS=[]
# ACP_AGENTS=codex,claude,my-agent
```

可执行文件留空时，系统会从 `PATH` 查找 `codex-acp` 和 `claude-agent-acp`。将 `ACP_ENABLED` 设为 `false` 后，Codex 会回退到原生 CLI / App Server 执行方式。

Codex 会话通过 `model/list` 动态读取桌面端的完整模型目录和默认模型，不维护静态白名单。macOS 会优先使用 Codex / ChatGPT 桌面端内置的 Codex 可执行文件；若 ACP 适配器尚未支持桌面端新增的模型，选择该模型的会话会使用原生 Codex 通道执行。如需固定其他安装，可通过 `CODEX_EXECUTABLE` 显式覆盖。

历史会话默认读取 `CODEX_HOME/sessions`、`CODEX_HOME/archived_sessions` 和 `~/.claude/projects`。可覆盖为指定目录：

```dotenv
IDE_HISTORY_CODEX_DIR=
IDE_HISTORY_CLAUDE_DIR=
IDE_HISTORY_SCOPE=all
```

`IDE_HISTORY_SCOPE=workspace` 时，只显示 `CODEX_WORKSPACE_DIR` 及其子目录中的记录。原始记录只作为参考，不能作为新的系统指令直接执行；符合条件的本机 Codex 历史会话可从网页继续，其他历史数据保持只读。

## 多设备执行

在另一台设备上运行连接器，可将其 Agent 和历史会话注册到工作台：

```bash
WORKBENCH_URL=https://workbench.example.com \
WORKBENCH_TOKEN='<成员登录会话令牌>' \
WORKBENCH_DEVICE_NAME='开发机 MacBook' \
CODEX_WORKSPACE_DIR=/absolute/path/to/repository \
pnpm device:sync
```

也可以让连接器使用成员账号登录：

```bash
WORKBENCH_URL=https://workbench.example.com \
WORKBENCH_TENANT=default \
WORKBENCH_USERNAME=developer \
WORKBENCH_PASSWORD='<password>' \
pnpm device:sync
```

连接器默认只同步设备、会话和交接包，不会启动 Agent。需要让该设备承接远端任务时，增加 `WORKBENCH_EXECUTE_CODEX=true`，并保持连接器持续运行；执行模式不能和 `--once` 同时使用。

常用可选变量：

| 变量 | 说明 |
| --- | --- |
| `WORKBENCH_DEVICE_NAME` | 工作台中显示的设备名；默认使用主机名 |
| `WORKBENCH_DEVICE_DIR` | 连接器状态与交接包目录；默认 `.workflow-data/device` |
| `WORKBENCH_SYNC_EXCERPTS=true` | 同步会话摘要正文；默认不上传 |
| `WORKBENCH_EXECUTE_CODEX=true` | 启用远端 Agent 执行 |

## 任务时间线与会话归属

### 带上下文新开 Agent 会话

历史会话底部的“带上下文新开会话”和“新建任务”复用同一套运行配置界面与选择逻辑，可以明确选择项目、执行设备、工作目录、Git 分支、模型和思考强度。点击“带上下文新开会话”即可进入继承上下文的新会话；输入框已有文字时会一起发送，没有文字时只创建工作台会话，首次发送时再创建原生 Agent 会话并注入上下文。无需整理摘要、填写任务或确认交接包。任务时间线也提供“打开会话 / 切换 Agent”入口。

默认沿用来源设备和工作目录。也可以在运行配置中选另一台设备；跨设备时必须明确填写目标设备上的工作目录，可通过“选择目录”在目标设备上选择，不能直接沿用来源路径。目标设备必须运行 `WORKBENCH_EXECUTE_CODEX=true` 的连接器，并已同步可用 Agent/项目。两端代码仓库需由用户自行准备为同一仓库；此功能只传会话上下文，不复制代码或其他工作文件。系统读取固定边界内的用户消息、助手公开回复、工具记录及附件引用，并剔除 Codex 注入的插件列表、环境、技能和仓库指令等运行时包装；不迁移隐藏推理或工具授权。新会话自动归属原任务，继承记录可展开查看；再次切换时携带原上下文与新增对话，不重复嵌套之前的注入文本。

本机来源的完整原始快照保存在 SQLite 的 `session_contexts` 表；远端来源在工作台只保存来源标识及已同步片段，完整原始记录在连接器首次执行时于来源设备冻结。本机交接文件位于 `.workflow-data/context/<tenant>/handoff-<id>-<version>.md`，远端交接文件位于连接器的 `WORKBENCH_DEVICE_DIR/executions/context/`；文件按来源记录号列出用户目标、助手公开进展和全部可读取的历史记录（包括完整的长工具输出）。新会话收到目标设备上的文件路径和本轮消息，不再把历史正文重复塞入提示词；ACP 会话还会直接附带 MD 文件资源链接。配置了 `OPENAI_API_KEY` 时，本机默认使用 `AI_ASSIGNMENT_MODEL`（可由 `CONTEXT_SUMMARY_MODEL` 覆盖）对脱敏后的文本摘录再做模型归纳，每条结论附来源记录号；可设 `ENABLE_CONTEXT_SUMMARY=false` 关闭。远端连接器目前使用规则摘取。模型不可用或整理失败会在 MD 中明确标注，并保留规则摘取。启用模型整理时会把选取的历史文本发送到配置的 `OPENAI_BASE_URL`。历史中的 PNG、JPEG、GIF 和 WebP 图片会从 Base64 文本中提取到同目录的 `assets/`，按 SHA-256 去重，并以原始字节的数据 URI 内嵌在完整 MD 的对应消息处，不缩放或重新编码；支持图片输入的 ACP Agent 还会收到相同原始字节的原生图片内容块，Codex 原生通道也会收到对应的本地图片输入，以便视觉识别。单独存储的证据快照仅供内部核对，不要求 Agent 再读取第二个文件。

来源任务仍在工作台执行时，新会话会等待本轮结束再自动读取最终记录；执行结果未知时先核对，不自动重复发送。该等待机制只跟踪工作台管理的执行，外部客户端正在运行的会话应先结束当前轮次。ACP 连续聊天复用连接，重连时仅在 Agent 支持 `session/load` 时恢复；不支持恢复会明确报错，不偷偷改为另一个原生会话。

同设备远端交接仍在连接器本地冻结来源记录并生成自包含 MD，不要求 `WORKBENCH_SYNC_EXCERPTS`。跨设备 A→B 时，A 的连接器冻结完整原始记录，经当前租户的工作台传送带校验摘要的快照；B 的连接器仅在快照就绪后领取执行，在用户选定的 B 工作目录生成自包含 MD 和原始图片输入，再启动 Agent。工作台所在设备也可以是来源或目标。图片字节会经过工作台，不缩放或重新编码；旧版单次快照传输请求上限为 85 MB，新版按独立对象传输。上传和下载按设备连接器账号及目标执行归属校验，交接失败不会用同步摘要代替，也不会在启动结果未知时自动重试。再次从已交接会话切换时复用已保存的完整快照。代码、普通附件和原 Agent 的隐藏状态不会复制。旧的手工交接记录与原会话续聊功能保留。

会话提取、快照校验与打包已抽为 `packages/context-engine/` 工作区包，Codex/Claude 历史、Markdown 和问题记录来源位于 `packages/context-adapters/`。新版连接器使用 v3 清单和独立图片对象交接，图片按原始字节上传、按 SHA-256 去重并在目标设备还原；旧连接器仍可读取 v1 快照或 v2 包。服务端按租户、执行、来源设备和目标设备隔离对象，并保存不可覆盖的传输摘要。单张图片上限 12 MiB，单次图片总量上限 50 MiB；对象目前按整件重试，分片续传、普通附件文件和代码改动交付尚未接入。

本地 Markdown 文件或已冻结的 v1 快照可独立打成 v3 目录包，复制到另一台机器后校验、导入：

```bash
pnpm context:bundle -- pack-markdown /absolute/source/root notes.md /absolute/output handoff-1
pnpm context:bundle -- pack-snapshot /absolute/snapshot.json /absolute/output handoff-2
pnpm context:bundle -- verify /absolute/output/handoff-1
pnpm context:bundle -- import-snapshot /absolute/output/handoff-1 /absolute/imported snapshot.json
```

`pack-markdown` 只读取授权根目录中的相对 Markdown 路径；`pack-snapshot` 要求来源是可校验的完整 v1 快照 JSON。目录包含 v3 清单和按摘要命名的原始图片字节，复制后 `verify` 会重建并校验原快照摘要，同时继续支持旧 v2 目录包。`import-snapshot` 将 v3 包还原为新的本地快照 JSON 文件，不覆盖已有文件，也不会自动写入任务、启动 Agent 或信任包内自称的租户身份。包内容属于不可信输入，导入后的使用仍需由宿主单独授权。架构、协议边界与后续阶段见[会话与数据流转核心引擎设计](docs/context-transfer-engine-design.md)。

任务详情把会话、执行、交接和任务变更按发生时间展示；会话可以原位展开并分页读取，工具记录默认折叠。搜索任务列表也会匹配关联会话的标题、Agent 和工作目录。后台更新通过“有新进展”提示，避免打断正在阅读的记录。

导航中的“Agent 历史会话”（`#history`）保留独立的会话列表、筛选和阅读界面。任务中心内的“未归属会话”用于预览历史、关联已有任务或从会话创建任务。历史会话关联后按原始时间回填，关联操作本身保留在当前时间。解除或移动关联保留原始记录，并检查任务版本及未结束的执行、交接。

执行完成后任务进入“待验收”，用户确认后才标记完成。“继续任务”通过已有执行通道创建新会话，携带任务上下文、所选来源的已同步片段（若可用）和补充指令；它不会恢复原会话的 Agent 内部状态。新会话自动归属原任务并保留接续来源。远端会话仍以连接器同步的片段为准，界面明确标示部分记录。

### 在网页继续原历史会话

打开“Agent 历史会话”，选择本机 Codex 会话，在底部输入框发送消息（支持 ⌘ / Ctrl + Enter）。服务使用 `thread/resume` 恢复原线程，再通过 `turn/start` 追加一轮；不创建替代线程，不覆盖原模型或权限配置。可通过“在 Codex 中打开”查看同一线程的持久记录。

网页显示本轮回复和状态，支持停止、处理审批或问题、核对未知结果，并可刷新原始记录。每次 Codex 执行使用独立 App Server 连接；完成、失败或停止后退订并关闭该执行的进程。重复提交同一个发送标识不会重复执行；会话忙碌或恢复失败时不会回退新建。未归属的会话首次续聊会自动创建关联任务，已有任务归属继续保留。

此入口支持工作台所在设备的 Codex 历史；Claude Code、远端片段暂不支持原会话恢复。已归档会话需先在客户端取消归档。恢复遇到写入占用时，服务会尝试通过本地客户端 IPC 发现拥有端并转发本轮消息（实验性内部协议，当前支持 macOS/Linux 的安全 Unix socket）。发现失败则保留未发送状态；提交后结果不确定时不自动重发，也不回退到另一执行通道。客户端桥接的审批和问题在客户端处理，网页读取本轮持久输出并以明确结束事件确认完成。“网页连接已释放”只表示工作台连接清理完毕，不会释放客户端持有的原会话。

真实执行器已经验证拥有端转发、回复读取、完成确认及网页连接释放；尚未完成浏览器点击与客户端界面同步的端到端验收。内部 IPC 协议可能随版本变化，详见[接入验证记录](docs/desktop-continuation-validation.md)。

## 多租户管理

使用内置命令管理组织：

```bash
pnpm tenant -- list
pnpm tenant -- add <组织ID> [组织名称]
pnpm tenant -- users <组织ID>
pnpm tenant -- reset-password <组织ID> <用户名>
pnpm tenant -- rotate <组织ID>
pnpm tenant -- migrate [组织ID]
```

新增组织后，将该组织的 Jira、Agent 和历史目录等配置写入：

```text
.workflow-data/tenants/<组织ID>.env
```

每个组织必须使用独立且互不嵌套的 `CODEX_WORKSPACE_DIR`。组织环境文件只接受 Jira、Issue Source、Agent、AI 和历史会话等受控变量，不会继承其他组织的凭据。

## 角色与权限

| 角色 | 查看数据 | 同步 / 分配 / 执行任务 | 配置与分配规则 | 成员管理 |
| --- | --- | --- | --- | --- |
| 组织所有者 | ✓ | ✓ | ✓ | 全部角色 |
| 管理员 | ✓ | ✓ | ✓ | 操作员、只读成员 |
| 操作员 | ✓ | ✓ | — | — |
| 只读成员 | ✓ | — | — | — |

停用成员或重置密码会撤销该成员的现有登录会话。组织所有者和管理员可以查看审计记录。

## 会话接口

所有接口都需要成员登录会话：

| 接口 | 说明 |
| --- | --- |
| `GET /api/sessions` | 稳定的会话交付列表 |
| `GET /api/sessions/:id` | 会话元数据 |
| `GET /api/sessions/:id/events` | 标准化事件 |
| `GET /api/sessions/:id/records` | 原始记录 |
| `GET /api/agent-sessions` | 工作台历史会话列表 |
| `GET /api/agent-sessions/:id` | 工作台历史会话详情 |
| `POST /api/sessions/:id/continue-as-new` | 带上下文新开会话；传入 requestId、targetAgent、可选 message |
| `GET /api/conversations` | 工作台创建的新会话 |
| `GET /api/conversations/:id/inherited` | 分页查看继承记录 |

## 数据、升级与备份

业务数据保存在 SQLite。数据库迁移会在启动时自动执行；第 4 版迁移保留缺陷与任务中心数据，并移除旧流水线运行和执行记录；第 5 版新增不可变会话上下文存储；第 6 版新增跨设备交付摘要与状态记录；第 7 版新增隔离的图片对象与 v3 清单存储。

备份建议：

1. 停止服务，避免复制到不一致的 SQLite 状态。
2. 复制 `DATABASE_PATH` 对应的数据库文件。
3. 复制 `TENANT_ENV_DIR`、`.workflow-data/context/`、需要保留的 Agent 历史目录和远端连接器状态目录。

不要让多个服务进程同时使用同一个 SQLite 文件。真实凭据、业务数据库、附件、日志和 Agent 历史不得提交到版本控制。

## 开发

前端计划采用 React + Vite 的纯 Web 架构；详细决策、工程边界和渐进迁移步骤见[Web 前端技术选型](docs/frontend-web-technology-selection.md)。

```bash
# 开发模式（监听源码变化）
pnpm dev

# 构建浏览器端并执行 TypeScript 检查
pnpm build

# 运行测试
pnpm test

# 生产方式启动（启动前自动构建浏览器端）
pnpm start
```

主要目录：

```text
web/          React Web 页面与 API 客户端
public/       迁移中的旧页面与公共样式；build/ 为生成产物
src/          服务端领域逻辑与集成
scripts/      租户管理、多设备连接器等命令
migrations/   SQLite 数据库迁移
test/         Node.js 测试
```

## License

[MIT](./LICENSE)
