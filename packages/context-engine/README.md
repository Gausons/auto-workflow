# Context Engine

这个工作区包负责数据源捕获结果校验、不可变快照、数据包完整性和便携目录包。无工作台、HTTP、SQLite、Agent 厂商依赖。

入口：

- `SourceRegistry.register/capture`：按来源 ID 注册并读取标准化事件。
- `freezeSnapshot/verifySnapshot`：生成与验证 `SessionContext v1` 兼容快照。
- `packSnapshot/verifyBundle`：生成与验证 v2 传输包；manifest 绑定快照身份、摘要和对象摘要。
- `detachSnapshot/restoreDetachedSnapshot`：生成 v3 清单，将原始图片字节拆成按 SHA-256 寻址的对象；还原后验证原 v1 快照摘要。
- `writeBundleDirectory/readBundleDirectory`：写入与校验旧 v2 目录包。
- `writeDetachedBundleDirectory/readDetachedBundleDirectory/importDetachedSnapshotDirectory`：导出、校验及导入 v3 原始字节目录包；导入只产生经过验证的本地快照文件。
- `loadOrFreezeCapture`：按宿主操作标识和身份指纹持久冻结来源快照；断线重试与进程重启复用同一份材料。

`@auto-workflow/context-adapters` 包含当前 Codex/Claude 会话交付适配器、受授权目录限制的 Markdown 适配器，以及只读问题记录适配器。新增数据源实现 `SourceAdapter` 即可复用上述流程。插件代码必须由宿主显式注册；来源材料和 Agent 输出均是不可信数据。

当前 HTTP 兼容层仍在工作台中；新版跨设备连接器使用 v3 清单和独立对象，旧 `SessionContext v1` 与 v2 数据包仍可读。图片的原生输入和 Markdown 呈现由现有工作台模块完成。协议版本改变时需新增版本及契约测试，不得原地改变 v1 摘要计算规则。
