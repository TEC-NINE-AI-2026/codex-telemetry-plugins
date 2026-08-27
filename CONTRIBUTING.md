# Contributing

Contributions are welcome through issues and pull requests.

Use the repository's [issue tracker](https://github.com/TEC-NINE-AI-2026/codex-telemetry-plugins/issues) for reproducible bugs and feature proposals that do not contain sensitive data.

## Development setup

Requirements:

- Node.js 22.5 or newer
- Codex CLI for local marketplace installation tests

Run the checks from the repository root:

```sh
npm run check
```

To test the repository as a local marketplace:

```sh
codex plugin marketplace add /absolute/path/to/codex-telemetry-plugins
codex plugin add codex-telemetry-dashboard@codex-telemetry-plugins
```

Restart the Codex desktop app and use a new task after reinstalling the plugin.

## Change guidelines

- Keep telemetry collection read-only with respect to Codex logs.
- Do not add collection of authentication data, reasoning text, tool commands, tool arguments, or tool outputs.
- Add regression tests for parsing, storage, lifecycle, or privacy changes.
- Keep Windows, macOS, and Linux entrypoints behaviorally aligned.
- Update the plugin version and changelog for a release.
- Never commit local databases, runtime files, logs, credentials, or real Codex session fixtures.
