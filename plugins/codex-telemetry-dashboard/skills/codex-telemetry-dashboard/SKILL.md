---
name: codex-telemetry-dashboard
description: Open, inspect, or stop the local Codex efficiency and health analytics dashboard for latency, model and reasoning-effort comparisons, cache efficiency, tool and multi-agent health, context pressure, reliability, concurrency, work modes, tokens, and usage limits. Use when the user asks for the Codex efficiency panel, health panel, performance panel, local telemetry, task timing, token statistics, tool health, agent activity, or usage trends. Do not use for OpenAI API billing analysis or application telemetry unrelated to the local Codex desktop logs.
---

# Codex Efficiency and Health Analytics Dashboard

Use the bundled deterministic scripts; do not inspect message bodies or authentication files yourself.

## Open the dashboard

1. Determine the access mode before launching. If the user did not specify one, ask whether the dashboard should be available only on this computer or to devices on the local network. Do not start until they answer.
   - `local` is the safe default and binds `127.0.0.1`.
   - `lan` binds `0.0.0.0`. Warn that anyone on a reachable network who has the access URL or Token can read derived metrics and task excerpts over unencrypted HTTP.
2. Choose the platform entrypoint from the plugin root and pass the selected mode:
   - Windows: run `scripts/launcher.ps1 --access=local` or `scripts/launcher.ps1 --access=lan` with PowerShell.
   - macOS or Linux: run `sh scripts/launcher.sh --access=local` or `sh scripts/launcher.sh --access=lan`.
3. Parse the single JSON object printed by the launcher. It contains `url`, `urls`, `accessMode`, `pid`, and `reused`.
4. Open `url` in the Codex browser panel on the right using the available Codex UI tool.
5. Tell the user whether the service was started or reused and which access mode is active. The authenticated dashboard displays the raw Token and copyable browser URLs; do not print the Token separately in chat.

If the Codex browser-panel tool is unavailable, open the URL in the system browser and explain the fallback.

## Stop the dashboard

Use the matching platform entrypoint: `scripts/stop.ps1` on Windows or `sh scripts/stop.sh` on macOS/Linux. Report whether a running service was stopped.

## Constraints

- The dashboard is read-only with respect to Codex logs.
- It may write only its derived SQLite database and runtime metadata under the current user's local application-data directory: `%LOCALAPPDATA%` on Windows, `~/Library/Application Support` on macOS, or `$XDG_DATA_HOME`/`~/.local/share` on Linux.
- Never read or expose `auth.json`, reasoning text, tool commands, tool arguments, or tool outputs.
- Treat local Codex JSONL fields as versioned internal data. Missing fields should appear as unavailable rather than being estimated.
