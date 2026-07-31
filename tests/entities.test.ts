import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorldGraph } from "../src/world-graph.js";

function withTempWg(fn: (wg: WorldGraph, dir: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "wg-test-"));
    const wg = await WorldGraph.create({
      dbPath: join(dir, "world.db"),
      eventLogPath: join(dir, "events.jsonl"),
    });
    try {
      await fn(wg, dir);
    } finally {
      wg.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test("birthEntity 创建实体 + 初始属性", withTempWg(async (wg) => {
  await wg.birthEntity("ent-macbeth", "character", { title: "Thane of Glamis" }, "act1-scene1");
  const snap = await wg.getEntityAt("ent-macbeth", "act1-scene1");
  assert.ok(snap, "实体应存在");
  assert.equal(snap.entityId, "ent-macbeth");
  assert.equal(snap.type, "character");
  assert.equal(snap.validFrom, "act1-scene1");
  assert.equal(snap.validTo, "Infinity");
  const titleDecl = snap.properties.find((d: any) => d.property === "title");
  assert.ok(titleDecl, "应有 title 属性声明");
  assert.equal(titleDecl.value, "Thane of Glamis");
  assert.equal(titleDecl.modality, "fact");
}));

test("birthEntity 后 getEntityAt 在更早时间返回 null", withTempWg(async (wg) => {
  await wg.birthEntity("ent-macbeth", "character", { title: "Thane" }, "act1-scene1");
  const snap = await wg.getEntityAt("ent-macbeth", "act0-scene0");
  assert.equal(snap, null, "实体诞生前应返回 null");
}));

test("killEntity 闭合实体 validTo", withTempWg(async (wg) => {
  await wg.birthEntity("ent-duncan", "character", { status: "alive" }, "act1-scene1");
  await wg.killEntity("ent-duncan", "act2-scene2");
  const before = await wg.getEntityAt("ent-duncan", "act2-scene1");
  assert.ok(before, "消亡前应存在");
  const after = await wg.getEntityAt("ent-duncan", "act2-scene2");
  assert.equal(after, null, "消亡时间点应返回 null");
}));

test("addRelation + getRelations", withTempWg(async (wg) => {
  await wg.birthEntity("ent-macbeth", "character", {}, "act1-scene1");
  await wg.birthEntity("ent-inverness", "location", {}, "act1-scene1");
  await wg.addRelation("ent-macbeth", "ent-inverness", "located_in", "act1-scene1");
  const neighbors = await wg.getRelations("ent-macbeth", "act1-scene1");
  assert.ok(neighbors.some((n: any) => n.targetId === "ent-inverness" && n.label === "located_in"));
}));

test("closeRelation 闭合关系", withTempWg(async (wg) => {
  await wg.birthEntity("ent-macbeth", "character", {}, "act1-scene1");
  await wg.birthEntity("ent-inverness", "location", {}, "act1-scene1");
  await wg.addRelation("ent-macbeth", "ent-inverness", "located_in", "act1-scene1");
  await wg.closeRelation("ent-macbeth", "ent-inverness", "located_in", "act2-scene1");
  const before = await wg.getRelations("ent-macbeth", "act1-scene2");
  assert.ok(before.some((n: any) => n.label === "located_in"), "闭合前应查到关系");
  const after = await wg.getRelations("ent-macbeth", "act2-scene1");
  assert.ok(!after.some((n: any) => n.label === "located_in"), "闭合后应查不到关系");
}));
