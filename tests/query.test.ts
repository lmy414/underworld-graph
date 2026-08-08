import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorldGraph } from "../src/world-graph.js";
import type { StateDeclaration } from "../src/types.js";

function withTempWg(fn: (wg: WorldGraph) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "wg-q-"));
    const wg = await WorldGraph.create({ dbPath: join(dir, "world.db"), eventLogPath: join(dir, "events.jsonl") });
    try { await fn(wg); } finally { wg.close(); rmSync(dir, { recursive: true, force: true }); }
  };
}

test("getAllEntities 返回所有有效实体", withTempWg(async (wg) => {
  await wg.birthEntity("e1", "character", {}, "t1");
  await wg.birthEntity("e2", "location", {}, "t1");
  await wg.killEntity("e1", "t2");
  const all = await wg.getAllEntities("t1");
  assert.equal(all.length, 2);
  const after = await wg.getAllEntities("t2");
  assert.equal(after.length, 1);
  assert.equal(after[0].entityId, "e2");
}));

test("traceCauses 多级回溯", withTempWg(async (wg) => {
  await wg.processEvent({ eventId: "evt-a", type: "birth", storyTime: "t1", entityId: "e1" });
  await wg.processEvent({
    eventId: "evt-b", type: "change", storyTime: "t2", entityId: "e1",
    invalidated: [], newFacts: [{ entityId: "e1", property: "p", description: "v1", modality: "fact" }],
    causedBy: "evt-a",
  });
  await wg.processEvent({
    eventId: "evt-c", type: "change", storyTime: "t3", entityId: "e1",
    invalidated: [], newFacts: [{ entityId: "e1", property: "p", description: "v2", modality: "fact" }],
    causedBy: "evt-b",
  });
  const chain = await wg.traceCauses("evt-c");
  assert.ok(chain);
  assert.deepEqual(chain!.map((e: any) => e.eventId), ["evt-a", "evt-b", "evt-c"]);
}));

// ============================================================================
// B5 台账修复（2026-08-07）：getAllEntities 消除 N+1
// 回归：批量输出必须与逐实体 getEntityAt 结果完全等价（含 recordedAsOf 透传）
// ============================================================================

test("B5: getAllEntities 输出与逐实体 getEntityAt 等价", withTempWg(async (wg) => {
  await wg.birthEntity("e1", "character", { name: "甲", mood: "happy" }, "t1", "摘要一");
  await wg.birthEntity("e2", "location", { temp: "cold" }, "t1");
  await wg.birthEntity("e3", "item", {}, "t1");
  await wg.processEvent({
    eventId: "evt-extra",
    type: "change",
    storyTime: "t2",
    entityId: "e1",
    newFacts: [{ entityId: "e1", property: "weapon", description: "枪", modality: "belief" }],
  });
  for (const t of ["t1", "t2"]) {
    const all = await wg.getAllEntities(t);
    assert.equal(all.length, 3);
    for (const snap of all) {
      const single = await wg.getEntityAt(snap.entityId, t);
      assert.deepEqual(snap, single, `getAllEntities 的 ${snap.entityId}@${t} 应与 getEntityAt 一致`);
    }
  }
  // recordedAsOf 透传：改写前时点不含后续补写的 weapon
  const before = await wg.recordedNow();
  await wg.processEvent({
    eventId: "evt-retcon",
    type: "change",
    storyTime: "t1",
    entityId: "e2",
    newFacts: [{ entityId: "e2", property: "retcon", description: "后补", modality: "fact" }],
  });
  const allAsWas = await wg.getAllEntities("t2", { recordedAsOf: before });
  for (const snap of allAsWas) {
    const single = await wg.getEntityAt(snap.entityId, "t2", { recordedAsOf: before });
    assert.deepEqual(snap, single, `recordedAsOf 下 ${snap.entityId} 应与 getEntityAt 一致`);
  }
  const e2snap = allAsWas.find((s) => s.entityId === "e2");
  assert.ok(!e2snap?.properties.some((d) => d.property === "retcon"), "recordedAsOf 应隔离后补写");
}));

// ============================================================================
// 0.3.0 E1 关闭验证：所有公开声明输出路径形状一致（含 description、不含 value/valueText）
// （计划 field-redesign-plan-2026-08-08 §六.5，2026-08-08）
// ============================================================================

test("0.3.0: E1 关闭——所有声明输出路径形状统一（description 必含，value/valueText 必无）", withTempWg(async (wg) => {
  await wg.birthEntity("e1", "character", { 名字: "甲", 心情: "happy" }, "t1");
  await wg.processEvent({
    eventId: "evt-1",
    type: "change",
    storyTime: "t2",
    entityId: "e1",
    newFacts: [{ entityId: "e1", property: "武器", description: "枪", modality: "belief" }],
  });
  await wg.setVisibility("e1", "decl-e1-武器-t2", {
    state: "known", confidence: 1, source: "experienced", validFrom: "t2", isExplicit: true,
  });

  const paths: StateDeclaration[][] = [
    (await wg.getEntityAt("e1", "t2"))!.properties,
    await wg.getAllDeclarationsAt("t2"),
    await wg.getAllDeclarations(),
    (await wg.getEntityHistory("e1")).facts,
    await wg.getCharacterView("e1", "t2"),
  ];
  for (const decls of paths) {
    assert.ok(decls.length > 0, "每个输出路径都应返回声明");
    for (const d of decls) {
      const rec = d as Record<string, unknown>;
      assert.equal(typeof rec.description, "string", "所有路径应含 description");
      assert.ok(!("value" in rec), "输出不应含 value 键");
      assert.ok(!("valueText" in rec), "输出不应含 valueText 键");
    }
  }
  // getAllEntities 快照内的 properties 同形状
  const all = await wg.getAllEntities("t2");
  for (const snap of all) {
    for (const d of snap.properties) {
      const rec = d as Record<string, unknown>;
      assert.equal(typeof rec.description, "string");
      assert.ok(!("value" in rec));
    }
  }
}));
