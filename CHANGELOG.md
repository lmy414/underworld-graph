# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-07-31

### Added
- Initial extraction from `narrative-engine` monorepo as independent package.
- Bi-temporal `WorldGraph` API: entities, facts, relations, visibility, events.
- SQLite + TypeGraph + sqlite-vec backend with schema migration support.
- JSONL append-only event log with `causedBy` causality tracing.
- Bi-temporal query support via `recordedAsOf` option (retcon isolation).
- Full test suite (12 test files) covering API, entities, events, visibility,
  character view, temporal queries, search, schema, migration.
- Smoke script (`npm run smoke`) for end-to-end verification.
- README, CHANGELOG, LICENSE (GPL-3.0-only).

### Changed
- Package name: `@pi/world-graph` → `underworld-graph`.
- Build: `tsc` emit (`.js` + `.d.ts`) replaces previous `emitDeclarationOnly` mode.
- `exports` now points to `./dist/index.js` (compiled) instead of `./src/index.ts` (source).
- Import specifiers in source switched from `.ts` to `.js` for tsc emit compatibility.
- `tsconfig.json`: `allowImportingTsExtensions: false`, `emitDeclarationOnly: false`,
  `rootDir: "./src"`, `include: ["src/**/*"]` (tests no longer in tsc compile unit).

### Notes
- Source uses TypeScript with `moduleResolution: "bundler"`.
- `private: false` — publicly published to npm as `underworld-graph@0.1.0`.
- Runtime path injection: `WorldGraphOptions.dbPath` / `eventLogPath` — the library
  is storage-agnostic and does not decide filesystem layout.
- Migrated to a standalone git repository (independent history from v0.1.0);
  no `git filter-repo` history carried over from `narrative-engine`.
