# GitHub 发布清单

## 首次发布

1. 使用已经创建的仓库：[TEC-NINE-AI-2026/codex-telemetry-plugins](https://github.com/TEC-NINE-AI-2026/codex-telemetry-plugins)。
2. 提交并推送：

```powershell
Set-Location E:\project\codex-telemetry-plugins
git add -A
git commit -m "feat(plugin): 发布 Codex 效率与健康度分析面板 Marketplace"
git remote add origin https://github.com/TEC-NINE-AI-2026/codex-telemetry-plugins.git
git push -u origin main
```

3. 等待 GitHub Actions 在 Windows、macOS 和 Linux 上全部通过。

## 干净环境验收

在一台未安装该插件的 Mac 上执行：

```sh
codex plugin marketplace add TEC-NINE-AI-2026/codex-telemetry-plugins
codex plugin add codex-telemetry-dashboard@codex-telemetry-plugins
codex plugin list
```

完全退出并重新打开 Codex，新建任务并输入：

```text
打开 Codex 效率与健康度分析面板
```

确认面板能打开后，再输入：

```text
停止 Codex 效率与健康度分析面板服务
```

## 创建版本标签

当前插件版本是 `1.2.1`。发布验证完成后，可以创建对应标签：

```powershell
git tag -a v1.2.1 -m "Codex Efficiency and Health Analytics Dashboard 1.2.1"
git push origin v1.2.1
```

## 后续更新

1. 修改插件源码和回归测试。
2. 更新插件清单中的 `version`、根目录 `package.json` 和 `CHANGELOG.md`。
3. 运行 `npm run check`。
4. 推送代码并等待三平台 CI 通过。
5. 用户执行以下命令刷新：

```sh
codex plugin marketplace upgrade codex-telemetry-plugins
codex plugin add codex-telemetry-dashboard@codex-telemetry-plugins
```
