# Repository Guidelines

## 项目结构与模块组织

本仓库用于打包 `codex-telemetry-dashboard` 插件。Marketplace 元数据位于 `.agents/plugins/marketplace.json`，插件清单位于 `plugins/codex-telemetry-dashboard/.codex-plugin/`。浏览器端资源放在 `assets/`，Node.js 数据采集、服务和启动器代码放在 `scripts/`，Codex 使用流程记录在 `skills/codex-telemetry-dashboard/SKILL.md`。测试位于 `plugins/codex-telemetry-dashboard/tests/`，脱敏样例数据放在 `tests/fixtures/`。仓库级校验脚本为 `scripts/validate-repository.mjs`。修改用户文档时，应同步检查 `README.md`、`README.zh-CN.md` 和 `docs/`。

## 构建、测试与开发命令

- `npm run validate`：检查清单、版本、必需文件和仓库约定。
- `npm test`：使用 Node.js 内置的 `node:test` 运行测试套件。
- `npm run check`：依次执行校验和全部测试；提交拉取请求前必须运行。

前端无需单独构建，HTML、CSS 和 JavaScript 会被直接提供。进行本地集成测试时，可添加此仓库并安装插件：

```text
codex plugin marketplace add /absolute/path/to/codex-telemetry-plugins
codex plugin add codex-telemetry-dashboard@codex-telemetry-plugins
```

重新安装插件后重启 Codex。

## 编码风格与命名约定

使用 ESM（`.mjs`）、两空格缩进、分号和单引号，并遵循相邻代码的风格。变量与函数使用 `camelCase`，类使用 `PascalCase`，文件使用短横线命名，例如 `access-mode.mjs`。Windows、macOS 和 Linux 启动器应保持行为一致。本项目未配置自动格式化工具，因此请保持现有风格并以 `npm run check` 为最终校验。

## 测试指南

测试文件命名为 `*.test.mjs`，测试标题应描述可观察行为。解析、存储、服务认证、启动生命周期、面板状态或隐私边界发生变化时，必须增加回归测试。测试数据只能使用合成且已脱敏的样例。项目没有硬性覆盖率阈值，但所有变更行为都应被测试覆盖。

## 提交与拉取请求指南

近期提交采用 Conventional Commits，例如 `feat(dashboard): ...` 和 `fix(telemetry): ...`。主题应简洁，并使用 `dashboard`、`telemetry` 或 `plugin` 等明确范围。拉取请求需包含变更摘要、相关 Issue（如有）、`npm run check` 结果、平台影响说明，以及可见界面变更的截图。发布相关变更还需同步更新插件版本和 `CHANGELOG.md`。

## 安全与配置提示

遥测逻辑必须只读访问 Codex 日志。禁止提交凭证、本地数据库、运行时文件、日志、真实会话样例、推理文本，以及工具命令、参数或输出。敏感漏洞应通过 GitHub Security Advisories 私下报告。局域网模式会监听所有 IPv4 接口，应视为对外暴露；访问控制仍依赖面板 Token。
