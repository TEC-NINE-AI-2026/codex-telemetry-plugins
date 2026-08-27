# Codex Telemetry Plugins

[简体中文](README.zh-CN.md)

This repository is a Git-backed Codex plugin marketplace containing **Codex Efficiency and Health Analytics Dashboard**: a local, read-only dashboard for performance, model efficiency, cache behavior, tool and agent health, context pressure, reliability, concurrency, work modes, and usage-limit snapshots.

> This is a community project and is not an official OpenAI product.

## Highlights

- Breaks each turn into receive, reasoning, tool, commentary, and final-response timing.
- Compares models and reasoning efforts by completion rate, latency, TTFT, token usage, cache hit rate, and reasoning share.
- Summarizes safe tool names and categories, normalized failures, anonymized multi-agent activity, concurrency, and work modes when Codex provides them.
- Tracks context-window pressure and compaction with explicit 70% warning and 85% danger heuristics.
- Filters by time range, project, model, reasoning effort, task status, and work mode.
- Runs locally and binds its HTTP server to `127.0.0.1`.
- Supports Windows, macOS, and Linux.

## Requirements

- Codex desktop app or Codex CLI with plugin support.
- Node.js 22.5 or newer when a compatible bundled Node.js runtime is unavailable.
- A local Codex session history under `~/.codex` (or `CODEX_HOME`).

## Install from GitHub

Install directly from the published GitHub repository:

```sh
codex plugin marketplace add TEC-NINE-AI-2026/codex-telemetry-plugins
codex plugin add codex-telemetry-dashboard@codex-telemetry-plugins
```

For a private repository, use an authenticated SSH URL if needed:

```sh
codex plugin marketplace add git@github.com:TEC-NINE-AI-2026/codex-telemetry-plugins.git
codex plugin add codex-telemetry-dashboard@codex-telemetry-plugins
```

Restart the Codex desktop app and open a new task so the installed skill is loaded. Example prompts:

- `Open the Codex efficiency and health analytics dashboard.`
- `Show my Codex efficiency and health metrics for the last 7 days.`
- `Stop the Codex efficiency and health analytics dashboard service.`

Codex supports GitHub repositories, Git URLs, and local directories as marketplace sources. See the [official plugin packaging documentation](https://developers.openai.com/plugins/build/plugins).

## Install from a local checkout

```sh
git clone https://github.com/TEC-NINE-AI-2026/codex-telemetry-plugins.git
cd codex-telemetry-plugins
codex plugin marketplace add "$(pwd)"
codex plugin add codex-telemetry-dashboard@codex-telemetry-plugins
```

On Windows PowerShell, register the resolved checkout path:

```powershell
git clone https://github.com/TEC-NINE-AI-2026/codex-telemetry-plugins.git
Set-Location codex-telemetry-plugins
codex plugin marketplace add (Get-Location).Path
codex plugin add codex-telemetry-dashboard@codex-telemetry-plugins
```

## Update

```sh
codex plugin marketplace upgrade codex-telemetry-plugins
codex plugin add codex-telemetry-dashboard@codex-telemetry-plugins
```

Restart Codex and use a new task after reinstalling.

## Uninstall

```sh
codex plugin remove codex-telemetry-dashboard@codex-telemetry-plugins
codex plugin marketplace remove codex-telemetry-plugins
```

Uninstalling does not delete the derived local database. See [Privacy](PRIVACY.md) for its location and removal instructions.

## Data and privacy

The plugin reads local Codex session metadata and writes a derived SQLite database into the current user's application-data directory. It stores only allowlisted operational dimensions and hashes agent identifiers before persistence. The dashboard includes truncated user-message and final-answer excerpts. It is designed not to store authentication data, reasoning text, tool commands, tool arguments, tool outputs, error bodies, raw agent identifiers, or unknown payload content, and it does not upload analytics. Review [Privacy](PRIVACY.md) and [Security](SECURITY.md) before deployment.

## Development

```sh
npm run check
```

The check validates the marketplace and plugin manifest, then runs the parser, security, platform-path, and launcher lifecycle tests. GitHub Actions runs the same suite on Windows, macOS, and Linux.

Repository layout:

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

## License

[MIT](LICENSE)
