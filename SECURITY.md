# Security policy

## Supported version

Security fixes are applied to the latest version on the default branch.

## Reporting a vulnerability

Do not open a public issue containing credentials, private Codex logs, task content, or a working exploit. Report vulnerabilities privately through [GitHub Security Advisories](https://github.com/TEC-NINE-AI-2026/codex-telemetry-plugins/security/advisories/new).

Include the affected version, operating system, reproduction steps, expected impact, and any suggested mitigation. Remove tokens, credentials, private paths, and message content before sending diagnostics.

## Security design

- The HTTP server binds only to `127.0.0.1`.
- API requests require a randomly generated per-process token.
- The dashboard does not upload telemetry or contact a remote analytics service.
- The collector does not read Codex authentication files.
- Reasoning text, tool commands, tool arguments, tool outputs, error bodies, raw agent identifiers, and unknown payload content are excluded from the derived database.
- Tool metadata is allowlisted, status values are normalized, and agent identifiers are hashed before persistence.
- Runtime files are stored in the current user's application-data directory.

The dashboard reads local Codex session files. Install it only from a source you trust and review changes before upgrading.
