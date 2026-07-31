// packages/world-graph/tests/migrate.test.ts
/**
 * WorldGraph.migrate 测试
 *
 * 覆盖：
 * - 新库迁移：版本号 1 → 2（typegraph 提交新 schema 版本）
 * - 旧 schema 库全链路：伪造旧版 schema_doc（Visibility.source 从 enum
 *   退化为 string，模拟 2026-07 之前的库）→ create 抛 MIGRATION_ERROR
 *   → migrate 修复 → create 正常打开
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { WorldGraph } from "../src/index.js";

let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "wg-migrate-"));
});

after(() => {
  // Windows 上 WAL 文件释放有延迟，rm 需重试
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function opts(sub: string) {
  const d = join(dir, sub);
  mkdirSync(d, { recursive: true });
  return { dbPath: join(d, "world.db"), eventLogPath: join(d, "events.jsonl") };
}

test("migrate: 新库迁移版本号递增", async () => {
  const o = opts("a");
  const wg = await WorldGraph.create(o);
  wg.close();
  const r = await WorldGraph.migrate(o);
  assert.equal(r.fromVersion, 1);
  assert.equal(r.toVersion, 2);
  // 迁移后仍可正常打开
  const wg2 = await WorldGraph.create(o);
  wg2.close();
});

test("旧 schema 库：create 抛 MIGRATION_ERROR → migrate 修复 → create 成功", async () => {
  const o = opts("b");
  const wg = await WorldGraph.create(o);
  wg.close();

  // 伪造旧版：active 行的 schema_doc 退化为 string（去 enum）且 hash 不匹配
  // （ensureSchema 先比 hash，不一致才计算 diff；doc 与 hash 需同时改）
  const db = new Database(o.dbPath);
  const row = db
    .prepare("SELECT * FROM typegraph_schema_versions WHERE graph_id = ?")
    .get("world") as { version: number; schema_doc: string };
  const doc = JSON.parse(row.schema_doc);
  const src = doc.nodes.Visibility.properties.properties.source;
  delete src.enum; // 旧版为纯 string
  db.prepare(
    "UPDATE typegraph_schema_versions SET schema_doc = ?, schema_hash = ? WHERE graph_id = ? AND version = ?",
  ).run(JSON.stringify(doc), "old-schema-hash", "world", row.version);
  db.close();

  // create 应报 MIGRATION_ERROR
  await assert.rejects(WorldGraph.create(o), (e: Error & { code?: string }) => {
    assert.equal(e.code, "MIGRATION_ERROR");
    return true;
  });

  // migrate 修复后 create 成功
  const r = await WorldGraph.migrate(o);
  assert.ok(r.toVersion > r.fromVersion);
  const wg2 = await WorldGraph.create(o);
  wg2.close();
});

test("migrate: 空库（schema 未初始化）抛错", async () => {
  const o = opts("c");
  // 只建空文件（better-sqlite3 打开即建库，但无 schema_versions 表记录）
  const db = new Database(o.dbPath);
  db.close();
  await assert.rejects(WorldGraph.migrate(o), /无需迁移|未初始化/);
});
