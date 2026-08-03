# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-08-03

### Changed
- 纯内部清理 7 项，不改公共 API / 数据格式 / 调用语义（零下游影响）。
- INFINITY 常量统一导出到 `types.ts`，`character-view.ts` 删除 dead code 本地定义。
- `findNodes` 返回 `GraphRecord[]`，30+ 处 `(x: any)` 改为类型化；抽 `asEmbedding(vec)`
  helper 集中 `EmbeddingValue` branded type 双重断言。
- `processEvent` 加 async mutex（`_writeLock` + `withWriteLock`），多步异步写串行化
  保证一致性。范围只锁 `processEvent`，其他写入方法未覆盖（注释已说明）。
- `EventLog` 加 no-op `close()`，`WorldGraph.close` 调用之（资源语义对称）。
- README `migrate` 措辞修正：legacy db schema → TypeGraph schema version。
- `package.json` `@nicia-ai/typegraph` `^0.40.0` → `~0.40.0`（锁 minor，允许 patch）。
- `declaresEdge` 补注释：预留未用，删除会触发 `schema_hash` 变化导致 `MIGRATION_ERROR`。

### Notes
- 对应 `docs/design-review-2026-08-02.md` 的 P2-5 / P3-9 / P3-10 / P3-13 等评审项。
- 验证：`npm run typecheck` 通过，`npm test` 59/59 全绿。
- 后续待修：B 类实现优化（valueText 序列化、EventLog 容错、inferVisibility 幂等、
  事务回滚、全表扫描），C 类向后兼容扩展，D 类需消费方对齐的破坏性修复。

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
