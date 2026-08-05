# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] - 2026-08-05

### Fixed
- B 类实现优化 4 项（对应 0.1.1 Notes「后续待修」清单，均不破坏公共 API）：
  - **valueText 序列化**：`String(value)` → `serializeValueText()`。对象/数组 value
    不再落 `"[object Object]"`，改为 JSON 序列化（Date 走 ISO、循环引用回退 String），
    fulltext 检索可命中对象内部文本。
  - **EventLog 容错**：`readAll` 遇损坏行跳过而非整体抛错，单行坏数据不丢全部日志。
  - **inferVisibility 幂等**：写入前检查该角色对目标声明是否已有未撤销可见性，
    重复执行不再产生重复 `vis-` 记录。
  - **processEvent 事务回滚**：DB 写入改走 SDK `store.transaction(tx)`，birth/death/
    change 的多步写原子提交，中途失败整体回滚；JSONL 先写保持因果链审计语义。
    `birthEntity`/`killEntity` 重构为 core 方法 + store.nodes 路由，事务内复用 tx.nodes。
  - **inferVisibility 撤销回填修复**（审查 P1）：去重改为全历史判定（含已闭合记录）；
    存在 `validTo <= storyTime` 的闭合记录时，新记录 validFrom 取当前推断时刻，
    避免回填到撤销时刻之前静默覆盖撤销区间。
  - **Invalid Date 兜底**（审查 P2）：`serializeValueText` 的 Date 分支包 try/catch，
    `toISOString()` 失败回退 `String()`，不再抛 RangeError。
  - **EventLog 形状校验**（审查 P2）：`readAll` 用 `EventRecord.safeParse` 校验，
    "合法 JSON 但缺字段/类型错"的行同样跳过，避免 `getAllEvents` 的 sort 炸 TypeError。

### Notes
- 事务实现说明：TypeGraph store 写入自带事务（raw BEGIN 会冲突），故外层不能
  再用 `db.exec("BEGIN")` 包裹；改用官方 `store.transaction()`，事务内读写必须
  走 `tx` 上下文（穿插 `store` 直读会触发 SDK deadlock 报错）。
- 验证：`npm run typecheck` 通过，`npm test` 66/66 全绿，`npm run smoke` 通过。

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
