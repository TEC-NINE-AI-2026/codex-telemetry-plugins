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
- 提供完整指标说明、可见 Token 和可复制的普通浏览器访问地址。
- 默认只监听本机 `127.0.0.1`；确认后可监听 `0.0.0.0` 供局域网访问。
- 支持 Windows、macOS 和 Linux。

## 环境要求

- 本机存在 `~/.codex`（或 `CODEX_HOME`）下的 Codex 会话记录。
- 独立 CLI 需要 Node.js 22.5 或更高版本；插件工作流也可以使用兼容的 Codex 内置 Node.js。
- 只有使用插件和 Skill 工作流时，才需要支持插件的 Codex 桌面应用或 Codex CLI。

## 不通过 Codex 或 Agent 直接运行

独立 CLI 会启动同一个本地面板，不需要安装 Codex 插件，也不需要让 Agent 执行 Skill。先从源码安装：

```sh
git clone https://github.com/TEC-NINE-AI-2026/codex-telemetry-plugins.git
cd codex-telemetry-plugins
npm install -g .
```

直接运行 `codex-telemetry` 会以仅本机模式启动服务，并在系统默认浏览器中打开已认证面板。完整生命周期命令如下：

```sh
codex-telemetry
codex-telemetry start --no-open
codex-telemetry open
codex-telemetry status
codex-telemetry stop
```

所有生命周期命令都支持 `--json` 机器可读输出。局域网模式必须显式指定：

```sh
codex-telemetry start --access=lan
```

局域网模式会通过未加密 HTTP 监听全部 IPv4 接口。任何能够连接此电脑并持有访问 URL 或 Token 的设备都能读取派生指标和任务摘录；CLI 不会配置 TLS 或防火墙。

开发时可使用 `npm link` 替代 `npm install -g .`。当前版本仅支持源码安装，不发布到 npm Registry。移除全局源码安装：

```sh
npm uninstall -g codex-telemetry-plugins-marketplace
```

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

打开面板时，如果提示选择访问范围：

- “仅本机”只允许当前电脑访问，是默认和推荐选项。
- “允许局域网”监听所有 IPv4 接口。任何能够连接此电脑并持有访问 URL 或 Token 的设备都能读取派生指标和任务摘录；连接使用 HTTP，不提供 TLS，也不会自动配置防火墙。

平台启动脚本仍作为直接兼容入口和 Skill 工作流入口保留：

```powershell
# Windows
./plugins/codex-telemetry-dashboard/scripts/launcher.ps1 --access=local
./plugins/codex-telemetry-dashboard/scripts/launcher.ps1 --access=lan
```

```sh
# macOS / Linux
sh plugins/codex-telemetry-dashboard/scripts/launcher.sh --access=local
sh plugins/codex-telemetry-dashboard/scripts/launcher.sh --access=lan
```

交互式终端省略 `--access` 时会提示选择；非交互环境安全回退为 `local`。启动后，已认证面板会直接显示当前 Token 和所有可复制的访问地址。

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

更新独立 CLI 的源码安装：

```sh
git pull
npm install -g .
```

更新 Codex 插件安装：

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

该命令会校验 Marketplace、插件清单和 CLI bin 入口，并运行解析、隐私安全、平台路径、CLI 和启动生命周期测试。GitHub Actions 会在 Windows、macOS 和 Linux 上运行同一套检查。

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
