import { test } from "node:test";
import assert from "node:assert/strict";
import { WorldGraph } from "../src/world-graph.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";

async function withTempWg() {
  const dir = mkdtempSync(join(tmpdir(), "wg-api-"));
  const wg = await WorldGraph.create({
    dbPath: join(dir, "test.db"),
    eventLogPath: join(dir, "events.jsonl"),
  });
  return { wg, dir };
}

test("WorldGraph 暴露 search getter", async () => {
  const { wg } = await withTempWg();
  assert.ok(wg.search, "wg.search 应存在");
  assert.equal(typeof wg.search.fulltext, "function");
  assert.equal(typeof wg.search.vector, "function");
  assert.equal(typeof wg.search.hybrid, "function");
  wg.close();
});

test("WorldGraph 暴露 query 方法", async () => {
  const { wg } = await withTempWg();
  assert.equal(typeof wg.query, "function");
  const q = wg.query();
  assert.ok(q, "query() 应返回 QueryBuilder");
  wg.close();
});

test("WorldGraph 暴露 reembedAll 方法", async () => {
  const { wg } = await withTempWg();
  assert.equal(typeof wg.reembedAll, "function");
  // 空 store 调用应不抛错
  await wg.reembedAll({
    embedEntity: async () => [0],
    embedFact: async () => [0],
  });
  wg.close();
});

// ============================================================================
// P0-5 修复（2026-07-27）：updateFactEmbedding / updateEntityEmbedding 增量更新
// commit.ts 4.2.5 步使用，避免全量 reembedAll 的性能开销
// ============================================================================

test("WorldGraph 暴露 updateFactEmbedding / updateEntityEmbedding 方法", async () => {
  const { wg } = await withTempWg();
  assert.equal(typeof wg.updateFactEmbedding, "function");
  assert.equal(typeof wg.updateEntityEmbedding, "function");
  // 空 store 调用应不抛错（找不到时静默跳过）
  await wg.updateFactEmbedding("decl-nonexistent", [0, 0, 0]);
  await wg.updateEntityEmbedding("ent-nonexistent", [0, 0, 0]);
  wg.close();
});

test("updateFactEmbedding: 找不到 declarationId 时静默跳过", async () => {
  const { wg, dir } = await withTempWg();
  // 先写入一个 Fact
  await wg.birthEntity("e_lin", "character", { name: "林冲" }, "ch-1");
  // 调用不存在的 declarationId，应不抛错
  await wg.updateFactEmbedding("decl-nonexistent-fact", [1, 2, 3]);
  wg.close();
  // 清理（withTempWg 不自动清理 dir，手动 rm）
  const { rmSync } = await import("node:fs");
  rmSync(dir, { recursive: true, force: true });
});

test("updateFactEmbedding: 增量更新后 vector 检索可命中", async () => {
  const { wg, dir } = await withTempWg();
  try {
    // 写入一个 Entity 和 Fact（默认 embedding 字段为空）
    await wg.birthEntity("e_lin", "character", { name: "林冲" }, "ch-1");
    // declarationId 按 world-graph 生成规则：decl-{entityId}-{property}-{storyTime}
    const declarationId = "decl-e_lin-name-ch-1";
    // 增量更新该 Fact 的 embedding（512 维，第 0 维为 1）
    const vec = new Array(512).fill(0);
    vec[0] = 1;
    await wg.updateFactEmbedding(declarationId, vec);
    // 用相似向量检索 Fact，应能命中
    const queryEmbedding = new Array(512).fill(0);
    queryEmbedding[0] = 1;
    const hits = await wg.search.vector("Fact", {
      fieldPath: "embedding",
      queryEmbedding,
      limit: 10,
    });
    assert.ok(Array.isArray(hits), "vector 检索应返回数组");
    assert.ok(hits.length > 0, "应命中增量更新了 embedding 的 Fact");
  } finally {
    wg.close();
    const { rmSync } = await import("node:fs");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updateEntityEmbedding: 找不到 entityId 时静默跳过", async () => {
  const { wg, dir } = await withTempWg();
  try {
    await wg.updateEntityEmbedding("ent-nonexistent", [1, 2, 3]);
    // 不抛错即通过
  } finally {
    wg.close();
    const { rmSync } = await import("node:fs");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updateEntityEmbedding: 增量更新后 vector 检索可命中", async () => {
  const { wg, dir } = await withTempWg();
  try {
    await wg.birthEntity("e_lin", "character", { name: "林冲" }, "ch-1");
    // 增量更新 Entity 的 embedding
    const vec = new Array(512).fill(0);
    vec[0] = 1;
    await wg.updateEntityEmbedding("e_lin", vec);
    // 用相似向量检索 Entity，应能命中
    const queryEmbedding = new Array(512).fill(0);
    queryEmbedding[0] = 1;
    const hits = await wg.search.vector("Entity", {
      fieldPath: "embedding",
      queryEmbedding,
      limit: 10,
    });
    assert.ok(Array.isArray(hits), "vector 检索应返回数组");
    assert.ok(hits.length > 0, "应命中增量更新了 embedding 的 Entity");
  } finally {
    wg.close();
    const { rmSync } = await import("node:fs");
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// D1 台账修复（2026-08-07）：storyTime 可选格式校验（storyTimePattern）
// ============================================================================

async function withPatternWg(pattern?: RegExp) {
  const dir = mkdtempSync(join(tmpdir(), "wg-d1-"));
  const wg = await WorldGraph.create({
    dbPath: join(dir, "test.db"),
    eventLogPath: join(dir, "events.jsonl"),
    ...(pattern ? { storyTimePattern: pattern } : {}),
  });
  return { wg, dir };
}

test("D1: 配置 storyTimePattern 后非法 storyTime 抛错、合法通过", async () => {
  const { wg, dir } = await withPatternWg(/^ch\d{3}\.ev\d{3}$/);
  try {
    // 非法格式：各写入入口抛带 pattern 信息的 Error
    await assert.rejects(
      wg.birthEntity("e1", "character", {}, "act1-scene1"),
      /ch\\d\{3\}/,
      "birthEntity 非法 storyTime 应抛带 pattern 信息的错误",
    );
    await assert.rejects(
      wg.processEvent({ eventId: "evt-bad", type: "birth", storyTime: "t1", entityId: "e1" }),
      /不匹配/,
      "processEvent 非法 storyTime 应抛错",
    );
    await assert.rejects(
      wg.setVisibility("e1", "decl-x", {
        state: "known", confidence: 1, source: "experienced", validFrom: "bad", isExplicit: true,
      }),
      /不匹配/,
      "setVisibility 非法 validFrom 应抛错",
    );
    // 合法格式：正常通过
    await wg.birthEntity("e1", "character", {}, "ch001.ev001");
    await wg.addRelation("e1", "e1", "self", "ch001.ev002");
    await wg.updateEntitySummary("e1", "摘要", "ch001.ev003");
    await wg.closeRelation("e1", "e1", "self", "ch001.ev004");
    await wg.killEntity("e1", "ch001.ev005");
    const snap = await wg.getEntityAt("e1", "ch001.ev005");
    assert.equal(snap, null, "合法 storyTime 的全流程写入应生效");
  } finally {
    wg.close();
    const { rmSync } = await import("node:fs");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D1: 不配置 storyTimePattern 时任意格式通过（缺省不校验）", async () => {
  const { wg, dir } = await withPatternWg();
  try {
    await wg.birthEntity("e1", "character", {}, "任意格式 2026/8/3");
    const snap = await wg.getEntityAt("e1", "任意格式 2026/8/3");
    assert.ok(snap, "缺省不校验，任意 storyTime 格式应通过");
  } finally {
    wg.close();
    const { rmSync } = await import("node:fs");
    rmSync(dir, { recursive: true, force: true });
  }
});
