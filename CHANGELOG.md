# Changelog

All notable changes to this repository are documented here.

## 1.2.0 - 2026-08-27

- Expand the performance view into a five-tab Codex efficiency and health analytics dashboard.
- Add model and reasoning-effort comparisons, cache efficiency, tool health, anonymized multi-agent activity, context risk, reliability, concurrency, automation, and work-mode views.
- Add schema-v2 migration with privacy-preserving metadata backfill and explicit data-coverage states.
- Add the authenticated `/api/analytics` endpoint and effort/work-mode filters.
- Extend privacy, migration, analytics, and Windows shutdown regression coverage.

## 1.1.0 - 2026-08-27

- Package the dashboard as a Git-backed Codex plugin marketplace.
- Add cross-platform Node.js launch and stop entrypoints.
- Add macOS and Linux shell wrappers alongside the Windows PowerShell wrappers.
- Store derived data in the native per-user application-data directory on each platform.
- Add repository validation, lifecycle tests, documentation, and CI for Windows, macOS, and Linux.

## 1.0.0

- Initial local Windows release.
