# Privacy

Codex Efficiency and Health Analytics Dashboard is a local-only utility. It does not include remote analytics, telemetry upload, advertising, or an external account connection.

## Data read

The collector reads Codex session metadata from the current user's Codex home directory, normally `~/.codex`. It scans session JSONL files and the session index to derive timing and usage metrics.

It may process and store:

- task and session identifiers;
- task titles and working-directory paths;
- model and reasoning-effort labels;
- allowlisted speed, reasoning mode, execution mode, origin, and automation-kind labels when present;
- timing, stage, token, cache, context-window, compaction, concurrency, and subscription-limit metadata;
- safe tool category/name labels, normalized status values, and hashed agent relationships;
- truncated user-message and final-answer excerpts used by the local dashboard.

It is designed not to store authentication files, reasoning text, tool commands, tool arguments, tool outputs, error bodies, raw agent identifiers, or unknown event payload content.

## Data stored

The plugin writes a derived SQLite database, runtime metadata, and local server logs under:

- Windows: `%LOCALAPPDATA%\CodexTelemetryDashboard`
- macOS: `~/Library/Application Support/CodexTelemetryDashboard`
- Linux: `$XDG_DATA_HOME/CodexTelemetryDashboard` or `~/.local/share/CodexTelemetryDashboard`

Set `CODEX_TELEMETRY_DATA_DIR` to override the data directory for testing or controlled deployments.

## Data transmission

The dashboard server listens on `127.0.0.1` and serves the browser UI locally. The plugin code does not transmit collected data to the repository owner or another external service.

## Removing data

Stop the dashboard, then delete the platform-specific `CodexTelemetryDashboard` directory above. This removes the derived database and runtime files; it does not modify the original Codex session logs.
