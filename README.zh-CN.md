# Codex Telemetry Plugins

[English](README.md)

这是一个可通过 Git 分发的 Codex 插件 Marketplace，其中包含 **Codex 效率与健康度分析面板**：一个在本机运行的只读面板，用于分析性能、模型效率、缓存、工具与智能体健康、上下文压力、可靠性、并发、工作模式和订阅限额快照。

> 这是社区项目，不是 OpenAI 官方产品。

## 功能

- 将每轮任务拆分为接收、推理、工具、过程回复和最终回复耗时。
- 按模型和推理强度比较完成率、耗时、TTFT、Token、缓存命中率和推理占比。
- 汇总 Codex 明确提供的安全工具名称与类别、标准化失败、匿名化多智能体活动、并发和工作模式。
- 使用明确标注的 70% 预警、85% 危险启发式阈值分析上下文压力和压缩。
- 按时间、项目、模型、推理强度、状态和工作模式筛选。
- HTTP 服务只监听本机 `127.0.0.1`。
- 支持 Windows、macOS 和 Linux。

## 环境要求

- 支持插件的 Codex 桌面应用或 Codex CLI。
- 如果本机没有可用的 Codex 内置 Node.js，需要安装 Node.js 22.5 或更高版本。
- 本机存在 `~/.codex`（或 `CODEX_HOME`）下的 Codex 会话记录。

## 从 GitHub 安装

直接从已经发布的 GitHub 仓库安装：

```sh
codex plugin marketplace add TEC-NINE-AI-2026/codex-telemetry-plugins
codex plugin add codex-telemetry-dashboard@codex-telemetry-plugins
```

如果是私有仓库，可以使用已经配置好认证的 SSH 地址：

```sh
codex plugin marketplace add git@github.com:TEC-NINE-AI-2026/codex-telemetry-plugins.git
codex plugin add codex-telemetry-dashboard@codex-telemetry-plugins
```

安装后完全退出并重新打开 Codex，然后新建任务。可以这样使用：

- `打开 Codex 效率与健康度分析面板`
- `查看最近 7 天的 Codex 效率与健康指标`
- `停止 Codex 效率与健康度分析面板服务`

Codex 官方支持使用 GitHub 仓库、Git URL 或本地目录作为 Marketplace 来源，详见 [OpenAI 官方插件打包文档](https://developers.openai.com/plugins/build/plugins)。

## 从本地仓库安装

macOS 或 Linux：

```sh
git clone https://github.com/TEC-NINE-AI-2026/codex-telemetry-plugins.git
cd codex-telemetry-plugins
codex plugin marketplace add "$(pwd)"
codex plugin add codex-telemetry-dashboard@codex-telemetry-plugins
```

Windows PowerShell：

```powershell
git clone https://github.com/TEC-NINE-AI-2026/codex-telemetry-plugins.git
Set-Location codex-telemetry-plugins
codex plugin marketplace add (Get-Location).Path
codex plugin add codex-telemetry-dashboard@codex-telemetry-plugins
```

## 更新

```sh
codex plugin marketplace upgrade codex-telemetry-plugins
codex plugin add codex-telemetry-dashboard@codex-telemetry-plugins
```

重新安装后重启 Codex，并在新任务中使用。

## 卸载

```sh
codex plugin remove codex-telemetry-dashboard@codex-telemetry-plugins
codex plugin marketplace remove codex-telemetry-plugins
```

卸载插件不会自动删除派生数据库，具体位置和清理方法见 [隐私说明](PRIVACY.md)。

## 数据与隐私

插件读取本机 Codex 会话元数据，并在当前用户的应用数据目录中写入派生 SQLite 数据库。插件仅保存白名单运行维度，并在持久化前对智能体标识做稳定哈希。面板会保存并展示截断后的用户消息和最终回复摘录；设计上不保存认证数据、推理正文、工具命令、工具参数、工具输出、错误正文、原始智能体标识或未知事件内容，也不会上传分析数据。安装前建议阅读 [隐私说明](PRIVACY.md) 和 [安全说明](SECURITY.md)。

## 开发与验证

```sh
npm run check
```

该命令会校验 Marketplace 与插件清单，并运行解析、隐私安全、平台路径和启动生命周期测试。GitHub Actions 会在 Windows、macOS 和 Linux 上运行同一套检查。

仓库结构：

```text
.
├── .agents/plugins/marketplace.json
├── .github/workflows/test.yml
├── docs/
├── plugins/codex-telemetry-dashboard/
│   ├── .codex-plugin/plugin.json
│   ├── assets/
│   ├── scripts/
│   ├── skills/
│   └── tests/
└── scripts/validate-repository.mjs
```

## 许可证

[MIT](LICENSE)
