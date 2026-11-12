# Agent Workbench 开发机连接器

独立连接 Agent 工作台，支持远端任务执行、历史会话同步、原会话续聊、上下文交接和 Git 分支管理。开发机无需下载工作台项目源码，也无需安装 PostgreSQL、React、Vite 或 tsx。

需要 Node.js 22.16+，并在开发机安装、登录所需 Agent。Git 分支管理需要 Git。

## 安装与启动

推荐在工作台“设备与 Agent → 连接设备”点击“生成并复制部署命令”，在开发机终端粘贴运行。命令使用 Node.js 自带的 `npx` 获取最新连接器，兑换服务端的临时令牌后直接启动，无需密码、配置文件或全局安装。支持 macOS、Linux 和 Windows PowerShell，Google 登录账号也适用。

`--connect` 默认启动后台进程，在服务器确认设备上线后返回命令提示符，可以关闭终端。终端会显示连接标识、日志路径及停止命令。需要在 macOS 重新登录后自动上线时，可使用下文的常驻连接。

```bash
npx --yes agent-workbench-connector@latest --status
npx --yes agent-workbench-connector@latest --stop <连接标识>
```

日志和本机控制信息位于 `~/.workflow-data/connectors/`，仅当前用户可读；控制信息不包含工作台登录凭据或设备会话令牌。停止会取消同步、关闭连接并保留待核对的执行状态，不会自动重发 Agent 指令。重复连接同一设备会明确失败；先正常停止旧连接器，再生成新的部署命令。旧版前台进程仍需 Ctrl+C 退出。普通后台进程在退出系统登录、进程崩溃或电脑重启后需要重新接入。普通设备会话在 24 小时后过期。

排查时在部署命令末尾添加 `--foreground`，保持前台输出并用 Ctrl+C 停止；配置文件启动方式仍默认保持前台运行。后台启动失败会显示原因和日志路径，不会自动重试令牌兑换或切换连接方式。本机控制通道仅监听 `127.0.0.1`，通过独立随机密钥校验状态与停止请求，不根据持久化 PID 杀进程。控制端口由设备状态目录确定并由操作系统独占，异常退出会释放；若与其他本机程序端口冲突，会明确失败，需先检查并释放提示的端口。

`--connect <页面生成的参数>` 携带工作台地址、一次性临时令牌和有效期，不包含浏览器会话或账号密码。令牌最长 10 分钟有效，重新生成后旧命令失效。命令包含接入凭据，请勿分享；跨设备使用 HTTPS，回环地址可用 HTTP。普通模式兑换独立的 24 小时受限设备会话，仅保存在进程内存中。退出浏览器不影响已接入设备；账号停用、重置密码或撤销执行权限会使设备会话失效。退出普通连接器或授权失效后需在网页重新生成命令。

兑换不会跟随重定向、自动重试或回退到密码登录。网络失败会提示结果未知并停止，不启动替代连接。该模式不读取默认配置文件，不使用环境中的旧账号密码或令牌，不能与 `--env-file` / `--once` 混用；其他高级环境变量仍保留。设备会话通过父子进程的私有 IPC 通道传递，不放入后台进程的命令参数、环境变量、日志或控制文件。先停止已有连接器再启动。

维护者需先发布支持令牌版 `--connect` 的连接器，再部署带临时令牌接口、数据库迁移 008 及新版网页的工作台。未发布时，安装维护者提供的 tgz，使用 `agent-workbench-connector` 替换页面命令的 `npx --yes agent-workbench-connector@latest` 前缀。

高级用户仍可使用配置文件：

```bash
pnpm add -g agent-workbench-connector
agent-workbench-connector --env-file ./agent.env
```

手动创建 `agent.env`，填写 `WORKBENCH_URL`、`WORKBENCH_USERNAME` 和 `WORKBENCH_PASSWORD`。macOS/Linux 使用 `chmod 600 agent.env`，Windows 将文件权限限制为当前用户可读。

也可以把配置保存为 `~/.bugflow/agent.env`，然后直接运行 `agent-workbench-connector`。已有环境变量优先于文件；不自动加载当前目录的 `.env`。令牌登录仍支持 `WORKBENCH_TOKEN`。不要把密码或令牌放入命令行参数。

配置文件方式的进程需要保持前台运行，按 Ctrl+C 正常退出。仅同步模式配置 `WORKBENCH_EXECUTE_CODEX=false` 后，可以使用 `agent-workbench-connector --env-file ./agent.env --once` 单次同步。`agent-workbench-connector --help` 查看参数，`agent-workbench-connector --version` 查看版本。

执行模式主动连接工作台 `/api/realtime` 的 WebSocket 设备控制通道，令牌通过首条消息认证。收到任务、审批、停止、目录或 Git 请求变化后立即读取状态，并每 3 秒补查。执行输出、审批请求和执行状态先保存到本地日志，再通过同一条 WebSocket 回报，等待服务端保存确认。断线时会提示、继续补查并自动重连；未确认回报保留待重连重报，命令仍通过原有领取和持久回执处理，不会自动重发已提交的 Agent 指令。历史及图片同步独立每轮等待 30 秒，另有每 30 秒心跳；慢同步或目录选择器等待不会阻塞已有执行的停止与审批。退出时取消通知、在途请求和目录选择器，通过 HTTP 回报最后状态，并保存未结束执行供核对。使用这些能力需先更新工作台，再重新打包、升级并重启连接器，无需新增环境变量或数据库迁移；HTTPS 反向代理须允许 `/api/realtime` 的 WebSocket Upgrade。

工作台重启或重新部署后，只要地址、数据库和设备授权保持有效，运行中的连接器会自动重连，失败后的重试间隔最长 30 秒。执行模式重连成功后立即补发心跳，恢复设备在线状态；无需重新兑换部署令牌。若连接器已退出或 24 小时授权已过期，仍需在网页生成新命令接入。

持续连接时，启动阶段的身份检查与首次心跳遇到断网、超时、HTTP 408 / 429 或 5xx 也会自动重试，包括反向代理返回的非 JSON 错误页。启动重试和实时通道重连从约 1 秒开始指数退避，带随机间隔且最长 30 秒；通道稳定 30 秒后才重置间隔，避免抖动时反复快速重连。执行回报 15 秒未确认会关闭旧通道并重连，保留回执，不重发 Agent 指令。恢复后立即核对控制状态、补报心跳并记录连接日志。401 / 403 会停止连接器；临时令牌兑换、密码登录和 `--once` 不自动重试。后台首次接入仍限时 90 秒，超时取消并退出；停止时也会取消在途启动请求和重连等待。升级并重启连接器后生效，无需新增配置。

### macOS 常驻连接

工作台应用迁移 010 后，可用新版连接器的 `--service` 启用常驻连接。先用 `--status` 检查原连接器，必要时用 `--stop <连接标识>` 停止它。用普通用户安装连接器，然后从工作台重新生成部署命令。将生成命令里的 `npx --yes agent-workbench-connector@latest` 换成 `agent-workbench-connector`，并在末尾加上 `--service`。

```bash
pnpm add -g agent-workbench-connector
agent-workbench-connector --connect '<页面生成的部署参数>' --service
agent-workbench-connector --status
```

服务由当前用户的 launchd 管理。电脑重启后，登录 macOS 桌面即可自动上线。进程异常退出后会由系统重新拉起，继续使用原设备标识和执行记录。状态命令会显示是否已上线及日志路径。服务使用安装时的 Node 和连接器路径，移动安装位置或升级连接器前，请先停止常驻连接，升级后重新接入。

常驻凭据保存在 `~/.workflow-data/connectors/<连接标识>.service.json`，权限为 `0600`。凭据只适用于设备连接，启动时和运行中每 12 小时检查续期，距上次续期满 30 天后过期。服务保留安装时的 `PATH`、设备名称、执行和摘要开关、`CODEX_WORKSPACE_DIR`、`CODEX_EXECUTABLE`、`ACP_ENABLED` 及历史目录配置。更改这些设置后可停止并重新接入。

`agent-workbench-connector --stop <连接标识>` 停止常驻连接、移除登录启动项和本机凭据，并请求服务端撤销授权。若网络故障导致撤销未确认，命令会明确提示。授权失效后可用同一命令清理旧常驻配置，再生成新的部署命令。

## 状态与迁移

包名与命令名统一为 `agent-workbench-connector`。为兼容已有安装，默认配置目录仍保留 `~/.bugflow/agent.env`，设备状态目录也不变；无需迁移凭据或重建设备。若安装过旧命令，先停止旧进程，再使用新命令启动，避免两个连接器同时工作。

默认工作目录是当前用户主目录，可通过 `CODEX_WORKSPACE_DIR` 设置代码仓库。默认设备状态位于 `~/.workflow-data/devices/<连接标识>/`，按工作台地址、租户和账号隔离，从不同目录启动仍使用同一设备身份。安装目录不保存密码、会话或执行日志，升级 npm 包不会清除设备状态。

从源码版连接器迁移时，先正常停止旧进程，在配置中将 `WORKBENCH_DEVICE_DIR` 设置为旧状态目录的**绝对路径**，再启动新命令。保留该目录才能继续核对旧执行，不要同时运行两个连接器处理同一设备。显式相对状态目录仍相对于启动目录解析。

其他配置沿用源码版：`WORKBENCH_DEVICE_NAME` 设置设备名，`WORKBENCH_SYNC_EXCERPTS=false` 关闭摘要、逐条历史记录和图片预览同步，`ACP_*`、`CODEX_EXECUTABLE` 和 `IDE_HISTORY_*` 配置本机 Agent 及历史来源。连接器只负责连接和调度，不包含 Codex / Claude 可执行程序，也不复制用户业务仓库。

历史正文预览保留最近 30 条消息的角色、工具记录和轮次信息，每个会话最多 23,000 字符。新增或发生变化的会话会单独同步图片，不受 30 条窗口限制；在历史页“会话图片”中点击查看或下载原图。支持嵌入的 PNG、JPEG、GIF、WebP，单张最多 12 MiB、每个会话最多 50 MiB 或 1000 张，不缩放、不读取远程地址或任意本地路径。上传失败时保留待同步状态，重试只补传缺失图片。先更新工作台，再更新并重启连接器；图片功能不重置旧增量索引，也不全量回填旧会话。更早的文字记录仍在来源设备查看；关闭正文同步也会清除服务端已同步图片。

## 维护者打包

日常发布可在 GitHub **Actions → Release Agent → Run workflow** 选择 main 和 `patch` / `minor` / `major`。流程自动更新本包版本、提交并打标签，再启动现有 CI / CD 检查和 npm 发布；最终发布状态查看 CI / CD，而非仅看 Release Agent。main / 标签保护必须允许该机器人的推送，否则继续使用版本 PR 和手动标签，不绕过仓库规则。现有 npm Trusted Publisher 仍是 `ci-cd.yml`，无需更换。

在工作台仓库运行 `pnpm agent:pack`，生成 `dist/device-agent/agent-workbench-connector-0.3.3.tgz`。包内只包含编译后的连接器、说明、许可证和包元数据；上下文工作区代码已打包，无 `workspace:*` 运行时依赖，ACP SDK 由包管理器安装。源码改动后必须重新打包。

CI / CD 在 `agent-vX.Y.Z` 标签推送后执行完整检查，再发布同一次构建的 tgz。标签版本必须与本包版本一致，提交必须已合入 main；PR 和普通 main 提交只打包不发布。发布使用独立的 GitHub `npm` Environment 和 npm Trusted Publisher（`Gausons/auto-workflow`、`ci-cd.yml`、Environment `npm`），首次发布也可配置临时 `NPM_TOKEN` Secret。具体初始化步骤见仓库 README 的“连接器 npm 发布”。本机 npm 登录状态不会传递给 CI；包版本一旦发布不能覆盖。安装或构建本身不会自动发布，也不会要求用户在安装机器上构建。
