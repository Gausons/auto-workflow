# 客户端执行、网页转发：接入验证

验证日期：2026-09-19。

## 结论

独立 Node.js 进程通过本地 IPC 转发消息的两轮验证已通过。现已接入网页历史会话恢复冲突分支；回复通过只读轮询持久记录回传，结束依据原轮次明确的 task_complete/turn_aborted 事件。停止已实现定向 IPC 请求，尚未进行真实停止操作验收。此前“缺少 Node.js 可调用入口”的结论已被本次实测修正。

目标链路为：网页鉴权和提交 → 本地 IPC 路由器 → 会话拥有端执行 → 状态同步回网页。这个 IPC 属于已安装客户端的内部协议，不是官方承诺兼容的公开 API。独立启动 `codex app-server` 仍然是另一个写入者，不能替代 IPC 转发。

## 独立进程 IPC 验证（后续发现）

从 VS Code 插件 `openai.chatgpt-26.903.71938-darwin-x64` 的代码确认：

- 默认入口为 `$CODEX_HOME/ipc/ipc.sock`（默认 `~/.codex/ipc/ipc.sock`），不同于 app-server control socket。
- Unix 目录和 socket 分别以 0700、0600 保护，所属用户为当前用户。测试未修改权限。
- 消息为 4 字节小端长度前缀加 UTF-8 JSON；先 initialize，使用服务端分配的 clientId。
- `thread-owner-discovery` 版本 1 返回拥有者 clientId。
- `thread-follower-start-turn` 版本 2 将原线程的 turnStart 请求定向发给拥有端。
- 跟随者不接管 writer，不调用 thread/resume，也不退出拥有端。

保持官方应用运行，用独立 Node.js 脚本分别连接、发现、发送、断开；两轮均在原线程完成，JSONL 的 task_complete 记录如下：

| 轮次 | turn ID | 最终回复 |
| --- | --- | --- |
| 1 | `01a0ba29-a520-73e3-a853-88e614193ae0` | IPC 接续验证成功 |
| 2 | `01a0ba2a-0dfa-7df3-a2e7-d623aba8d742` | IPC 接续验证成功 |

发送不经过 Codex 对话内工具。完成结果由持久记录核对，并非由实验脚本自动同步。没有进行桌面 UI 渲染验收。

可复现脚本默认仅发现拥有者：

```bash
node scripts/codex-ipc-probe.mjs THREAD_ID
```

添加 `--send-probe` 会实际追加一条固定文本测试消息；脚本不自动重发，超时后必须核对原线程。`--read-probe` 仅用于诊断历史请求。

实测直接调用 `thread-follower-load-complete-history` 返回 `no-client-found: thread stream owner became unavailable`。根据代码，此方法依赖广播状态快照，返回错误不能独立证明拥有端已经退出。需要先实现跟随者注册与快照接收，再验证结果同步；不能将发送成功当成网页端到端成功。

## 实测证据

保持客户端运行，通过当前 Codex 对话提供的 `send_message_to_thread` 工具，向已有任务“回应问候”（`01a0b8c0-6e03-77e2-91b7-8677865362bb`）顺序发送两条仅要求文本回复的测试消息：

| 轮次 | turn ID | 持久记录中的最终回复 |
| --- | --- | --- |
| 1 | `01a0ba11-28d5-7322-8666-92fe8d8a6720` | 客户端接续验证 1 成功 |
| 2 | `01a0ba11-f3a7-7de1-a31e-fb633e5104e7` | 客户端接续验证 2 成功 |

`wait_threads` 返回两轮 completed、线程 idle。读取原线程 JSONL 的 `task_complete` 事件确认回复已落盘。工具 `read_thread` 对这两轮返回的 items 为空，因此没有仅凭该工具的完成状态推断消息可见性。

本次没有从网页发起测试，也没有完成桌面界面渲染验收。对话内工具成功不代表 Web 后端具有相同调用权限或传输通道。

## 接入检查

- 本机 `codex app-server daemon version` 返回默认 control socket 不存在。
- 本机 Codex 进程的 Unix socket 检查未发现可供外部连接的命名 App Server 监听端点。
- 当前对话中的客户端工具没有向项目暴露可长期使用的服务端 SDK 或 HTTP 地址。
- [OpenAI Docs：App Server](https://learn.chatgpt.com/docs/app-server) 描述 stdio、WebSocket 和 Unix socket 传输；它没有证明当前桌面进程已开放这些监听端点。
- [OpenAI Docs：Remote](https://learn.chatgpt.com/docs/remote) 描述官方移动端连接电脑的产品流程，不能据此推导出第三方网页可调用的公开 API。

没有使用私有工具管道冒充对话调用、修改客户端程序、删除线程锁或终止客户端进程。

## 网页接入待办与验收

下一步补齐跟随者状态订阅、版本检查、提交超时核对、拥有端退出处理，以及定向停止原 turn。审批继续由拥有端处理。网页必须沿用现有租户与执行权限校验，原线程由服务端历史索引解析；不得向浏览器暴露通用 IPC 调用或绕过本地用户权限。提交结果不确定时禁止自动回退到独立 App Server 重发。

验收必须从网页发送两轮消息，保持客户端打开；每轮在原线程中恰好出现一次用户消息及回复，网页和客户端都能读取结果。还需验证客户端发起下一轮、断线后的结果核对，以及审批留在执行端处理。未通过这些检查前，不宣称跨端接续完成。

## 正式执行器接入验证

历史会话 thread/resume 返回 writer 冲突后，尝试发现原线程拥有者并通过 IPC 提交。不在提交失败后重新 resume 或重新发送。IPC 断开后标记 unknown，用户可核对持久结果；审批继续在客户端处理。退出只关闭工作台 IPC 连接与只读 App Server，不退出拥有端。

实际 CodexRunner 验证轮次 `01a0ba32-acb2-7922-8bf7-5b5d81c0c895`：executionTransport=desktop-ipc、status=completed、output=网页桥接验证通过、releaseStatus=released。

验证中发现另一 App Server 可能将尚未写完的外部轮次重建为 interrupted，因此不能用该状态直接判断结束。实现以原线程记录路径中精确匹配 turn ID 的结束事件为准。当前每次只读末尾 4 MiB，缺失记录或新版本事件不兼容时不得推断成功。未完成浏览器和桌面 UI 联动验收；上述证据来自正式执行器及真实账号。
