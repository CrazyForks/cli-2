# Changelog

## 1.0.0

Initial open-source release.

- `wdl init` scaffolding for new WDL Worker projects, with bundled examples
  covering assets, KV, D1, R2, cron triggers, queues, Durable Objects,
  Workflows, and environment overrides.
- `wdl deploy` for Wrangler v4 projects: local bundling, manifest validation,
  upload, and promote against the WDL control plane.
- Resource management commands: `wdl d1`, `wdl r2`, `wdl secret`, `wdl workers`,
  `wdl workflows`, `wdl delete`.
- Diagnostics: `wdl config explain`, `wdl doctor`, `wdl whoami`, and live log
  streaming via `wdl tail`.
