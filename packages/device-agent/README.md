# Agent Workbench 开发机连接器

独立连接 Agent 工作台，支持远端任务执行、历史会话同步、原会话续聊、上下文交接和 Git 分支管理。开发机无需下载工作台项目源码，也无需安装 PostgreSQL、React、Vite 或 tsx。

需要 Node.js 22.16+，并在开发机安装、登录所需 Agent。Git 分支管理需要 Git。

## 安装与启动

发布到 npm 后安装：

```bash
npm install -g agent-workbench-connector
```

尚未发布到 registry 时，可直接安装维护者提供的安装包：

```bash
npm install -g ./agent-workbench-connector-0.3.0.tgz
```

在工作台“设备与 Agent → 连接本机 Agent”复制登录配置，保存到任意目录的 `agent.env`，填写密码。在 macOS/Linux 上运行 `chmod 600 agent.env`，Windows 上将文件权限限制为当前用户可读，然后启动：

```bash
agent-workbench-connector --env-file ./agent.env
```

也可以把配置保存为 `~/.bugflow/agent.env`，然后直接运行 `agent-workbench-connector`。已有环境变量优先于文件；不自动加载当前目录的 `.env`。令牌登录仍支持 `WORKBENCH_TOKEN`。不要把密码或令牌放入命令行参数。

进程需要保持运行，按 Ctrl+C 正常退出。仅同步模式配置 `WORKBENCH_EXECUTE_CODEX=false` 后，可以使用 `agent-workbench-connector --env-file ./agent.env --once` 单次同步。`agent-workbench-connector --help` 查看参数，`agent-workbench-connector --version` 查看版本。

## 状态与迁移

包名与命令名统一为 `agent-workbench-connector`。为兼容已有安装，默认配置目录仍保留 `~/.bugflow/agent.env`，设备状态目录也不变；无需迁移凭据或重建设备。若安装过旧命令，先停止旧进程，再使用新命令启动，避免两个连接器同时工作。

默认工作目录是当前用户主目录，可通过 `CODEX_WORKSPACE_DIR` 设置代码仓库。默认设备状态位于 `~/.workflow-data/devices/<连接标识>/`，按工作台地址、租户和账号隔离，从不同目录启动仍使用同一设备身份。安装目录不保存密码、会话或执行日志，升级 npm 包不会清除设备状态。

从源码版连接器迁移时，先正常停止旧进程，在配置中将 `WORKBENCH_DEVICE_DIR` 设置为旧状态目录的**绝对路径**，再启动新命令。保留该目录才能继续核对旧执行，不要同时运行两个连接器处理同一设备。显式相对状态目录仍相对于启动目录解析。

其他配置沿用源码版：`WORKBENCH_DEVICE_NAME` 设置设备名，`WORKBENCH_SYNC_EXCERPTS=false` 关闭摘要、逐条历史记录和图片预览同步，`ACP_*`、`CODEX_EXECUTABLE` 和 `IDE_HISTORY_*` 配置本机 Agent 及历史来源。连接器只负责连接和调度，不包含 Codex / Claude 可执行程序，也不复制用户业务仓库。

历史正文预览保留最近 30 条消息的角色、工具记录和轮次信息，每个会话最多 23,000 字符。新增或发生变化的会话会单独同步图片，不受 30 条窗口限制；在历史页“会话图片”中点击查看或下载原图。支持嵌入的 PNG、JPEG、GIF、WebP，单张最多 12 MiB、每个会话最多 50 MiB 或 1000 张，不缩放、不读取远程地址或任意本地路径。上传失败时保留待同步状态，重试只补传缺失图片。先更新工作台，再更新并重启连接器；图片功能不重置旧增量索引，也不全量回填旧会话。更早的文字记录仍在来源设备查看；关闭正文同步也会清除服务端已同步图片。

## 维护者打包

日常发布可在 GitHub **Actions → Release Agent → Run workflow** 选择 main 和 `patch` / `minor` / `major`。流程自动更新本包版本、提交并打标签，再启动现有 CI / CD 检查和 npm 发布；最终发布状态查看 CI / CD，而非仅看 Release Agent。main / 标签保护必须允许该机器人的推送，否则继续使用版本 PR 和手动标签，不绕过仓库规则。现有 npm Trusted Publisher 仍是 `ci-cd.yml`，无需更换。

在工作台仓库运行 `pnpm agent:pack`，生成 `dist/device-agent/agent-workbench-connector-0.3.0.tgz`。包内只包含编译后的连接器、说明、许可证和包元数据；上下文工作区代码已打包，无 `workspace:*` 运行时依赖，ACP SDK 由包管理器安装。源码改动后必须重新打包。

CI / CD 在 `agent-vX.Y.Z` 标签推送后执行完整检查，再发布同一次构建的 tgz。标签版本必须与本包版本一致，提交必须已合入 main；PR 和普通 main 提交只打包不发布。发布使用独立的 GitHub `npm` Environment 和 npm Trusted Publisher（`Gausons/auto-workflow`、`ci-cd.yml`、Environment `npm`），首次发布也可配置临时 `NPM_TOKEN` Secret。具体初始化步骤见仓库 README 的“连接器 npm 发布”。本机 npm 登录状态不会传递给 CI；包版本一旦发布不能覆盖。安装或构建本身不会自动发布，也不会要求用户在安装机器上构建。
