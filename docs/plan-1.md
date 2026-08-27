# Codex Telemetry Dashboard 个人插件

## 摘要

- 创建个人插件 `codex-telemetry-dashboard`，安装到 `C:\Users\Administrator\plugins\codex-telemetry-dashboard`，不修改当前 `p-fileserver` 项目。
- 通过“打开 Codex 性能面板”在 Codex 右侧浏览器面板启动中文仪表盘，统计全部本地及已归档任务。
- 只读取本机 Codex 会话日志，不调用模型或外部服务，不产生额外 token；官方 Responses 事件与 usage 字段可作为语义参考：[事件类型](https://developers.openai.com/api/reference/cli/resources/beta/subresources/responses)、[Token usage](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)。

## 实现变更

- 使用 `plugin-creator` 创建个人插件、技能、启动脚本和 Marketplace 条目；安装后在新任务中加载插件。
- 使用 Node.js 标准库启动隐藏的本地服务：
    - 仅监听 `127.0.0.1`，随机端口。
    - 优先使用 Codex bundled Node，回退到 PATH 中 Node。
    - 启动器复用已有进程，通过 URL fragment 传递随机访问令牌，并由 Codex 打开内嵌面板。
- 增量扫描 `C:\Users\Administrator\.codex\sessions`、`archived_sessions` 和 `session_index.jsonl`：
    - 按文件偏移继续读取，实时轮询新增 JSONL 事件。
    - 用 `thread_id / turn_id` 去重并合并续接、恢复和重复日志。
    - 未完成轮次显示实时计时；`task_complete`、`turn_aborted` 到达后固化结果。
    - 未识别的新事件跳过并计入诊断信息，不中断采集。
- 使用 Node 内置 SQLite 将标准化指标长期保存在 `%LOCALAPPDATA%\CodexTelemetryDashboard\metrics.sqlite`；不修改 Codex 原始日志。
- 阶段定义：
    - 接收：`task_started` 到首个模型输出，完成后以 `time_to_first_token_ms` 为准。
    - 推理：合并所有 `Reasoning` 区间。
    - 工具：合并 Command、MCP、Extension、文件修改及其他工具区间。
    - 中间回复：`AgentMessage/commentary`。
    - 最终回复：`AgentMessage/final_answer`。
    - 其他开销：总耗时减去各阶段区间并集，避免并行事件被重复计算。
    - 结束：`task_complete` 或 `turn_aborted`；缺失终止事件标记为 `incomplete`。
- Token 规则：
    - 每轮累计各 `token_count.info.last_token_usage`，不能直接使用跨轮累积的 `total_token_usage`。
    - 分别记录 input、cached input、cache-write input、output、reasoning output 和 total。
    - 推理阶段展示 reasoning token；回复阶段展示非 reasoning output token；input token 保持轮次级，避免虚构阶段分配。
    - 上下文展示最新值、峰值、模型窗口和占用百分比，并标记压缩事件。
    - 订阅区展示 plan、各限额窗口使用百分比、窗口长度、重置时间和 credits；字段缺失时显示“Codex 未提供”，不读取 `auth.json`。
- 仪表盘包含：
    - 当前运行轮次、实时总耗时和当前阶段。
    - 订阅使用量进度条及重置倒计时。
    - 今日、7 天、30 天、全部范围的 TTFT、总耗时、阶段耗时、token、上下文趋势及 P50/P95。
    - 项目、任务、模型、状态筛选。
    - 每轮摘要行；展开后显示阶段瀑布图和原始事件列表，每项均有开始、结束、耗时和可用的 token 数据。
    - 用户消息与最终回复各保存最多 160 个 Unicode 字符；不保存推理正文、工具命令、参数、输出或认证数据。
    - “清空历史”二次确认后删除指标并设置当前时间为重新导入截止点；另提供显式“重新导入全部原始日志”。

## 本地接口与数据类型

- `TurnMetric`：任务/轮次 ID、项目、模型、状态、接收/结束时间、TTFT、总耗时、各阶段耗时、token、上下文、订阅快照和两段摘录。
- `StageEvent`：阶段类型、状态、开始/结束/耗时及不敏感的工具类别。
- 只提供带本地令牌验证的同源接口：
    - `GET /api/summary`
    - `GET /api/tasks`
    - `GET /api/tasks/:threadId/turns`
    - `GET /api/events`，使用 SSE 推送实时变化
    - `POST /api/history/clear`
    - `POST /api/history/reimport`
- 页面不加载 CDN、字体或分析脚本，并设置限制外部连接的 CSP。

## 测试与验收

- 用脱敏 JSONL fixtures 覆盖完整轮次、多次模型调用、工具调用、上下文压缩、取消、失败、缺少 usage 和未知事件。
- 验证 token 按 `last_token_usage` 求和，跨轮累计字段不会导致重复统计。
- 验证并行/重叠事件使用区间并集，总阶段耗时不超过总耗时。
- 验证恢复任务和重复 rollout 不产生重复轮次；文件追加、截断和归档移动均可恢复。
- 检查 SQLite 中消息摘录不超过 160 字，且不存在推理正文、工具内容和认证字段。
- 验证服务只监听 localhost，缺少或错误令牌无法访问数据。
- 在 Codex 宽窄面板、浅色和深色模式下检查图表、筛选、展开和实时更新。
- 验收标准：缓存首屏 1 秒内显示；新增事件和任务结束后 2 秒内刷新；面板关闭期间产生的日志在下次打开时补录。
- 运行插件校验并完成个人 Marketplace 安装；在新 Codex 任务中确认插件可启动、复用和停止服务。

## 假设与默认值

- 目标是 Codex Desktop 的内嵌浏览器面板，不是原生侧栏源码改造。
- 界面使用中文，时间按本机 `Asia/Shanghai` 显示，同时保存 UTC 时间。
- Codex 本地 JSONL 属于内部格式，版本变化时采用兼容解析和诊断提示。
- 标准化历史长期保留，直到用户主动清空；原始 Codex 日志的生命周期不由插件改变。
