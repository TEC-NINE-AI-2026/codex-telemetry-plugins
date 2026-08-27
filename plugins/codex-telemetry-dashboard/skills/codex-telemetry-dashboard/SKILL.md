---
name: codex-telemetry-dashboard
description: Open, inspect, or stop the local Codex efficiency and health analytics dashboard for latency, model and reasoning-effort comparisons, cache efficiency, tool and multi-agent health, context pressure, reliability, concurrency, work modes, tokens, and usage limits. Use when the user asks for the Codex efficiency panel, health panel, performance panel, local telemetry, task timing, token statistics, tool health, agent activity, or usage trends. Do not use for OpenAI API billing analysis or application telemetry unrelated to the local Codex desktop logs.
---

# Codex Efficiency and Health Analytics Dashboard

Use the bundled deterministic scripts; do not inspect message bodies or authentication files yourself.

## Open the dashboard

1. Choose the platform entrypoint from the plugin root:
   - Windows: run `scripts/launcher.ps1` with PowerShell.
   - macOS or Linux: run `sh scripts/launcher.sh`.
2. Parse the single JSON object printed by the launcher. It contains `url`, `pid`, and `reused`.
3. Open `url` in the Codex browser panel on the right using the available Codex UI tool.
4. Tell the user whether the local service was started or reused. Do not print the access token separately.

If the Codex browser-panel tool is unavailable, open the URL in the system browser and explain the fallback.

## Stop the dashboard

Use the matching platform entrypoint: `scripts/stop.ps1` on Windows or `sh scripts/stop.sh` on macOS/Linux. Report whether a running service was stopped.

## Constraints

- The dashboard is read-only with respect to Codex logs.
- It may write only its derived SQLite database and runtime metadata under the current user's local application-data directory: `%LOCALAPPDATA%` on Windows, `~/Library/Application Support` on macOS, or `$XDG_DATA_HOME`/`~/.local/share` on Linux.
- Never read or expose `auth.json`, reasoning text, tool commands, tool arguments, or tool outputs.
- Treat local Codex JSONL fields as versioned internal data. Missing fields should appear as unavailable rather than being estimated.
