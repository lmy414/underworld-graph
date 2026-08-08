import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorldGraph } from "../src/world-graph.js";

function withTempWg(fn: (wg: WorldGraph, dir: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "wg-vis-"));
    const wg = await WorldGraph.create({
      dbPath: join(dir, "world.db"),
      eventLogPath: join(dir, "events.jsonl"),
    });
    try { await fn(wg, dir); } finally { wg.close(); rmSync(dir, { recursive: true, force: true }); }
  };
}

test("setVisibility 显式声明角色知道某声明", withTempWg(async (wg) => {
  await wg.birthEntity("ent-macbeth", "character", { title: "Thane" }, "act1-scene1");
  const snap = await wg.getEntityAt("ent-macbeth", "act1-scene1");
  const titleDecl = snap!.properties.find((d: any) => d.property === "title")!;
  await wg.setVisibility("ent-macbeth", titleDecl.declarationId, {
    state: "known",
    confidence: 1,
    source: "experienced",
    validFrom: "act1-scene1",
    isExplicit: true,
  });
}));

test("inferVisibility 从 located_in 自动推断", withTempWg(async (wg) => {
  await wg.birthEntity("ent-macbeth", "character", {}, "act1-scene1");
  await wg.birthEntity("ent-inverness", "location", { visitor: "Duncan" }, "act1-scene1");
  await wg.addRelation("ent-macbeth", "ent-inverness", "located_in", "act1-scene1");
  await wg.processEvent({
    eventId: "evt-visit",
    type: "change",
    storyTime: "act1-scene4",
    entityId: "ent-inverness",
    newFacts: [{ entityId: "ent-inverness", property: "visitor", description: "Duncan", modality: "fact" }],
  });
  await wg.inferVisibility("act1-scene4");
}));

test("inferVisibility 幂等：重复执行不产生重复可见性记录", withTempWg(async (wg) => {
  await wg.birthEntity("ent-macbeth", "character", {}, "act1-scene1");
  await wg.birthEntity("ent-inverness", "location", { visitor: "Duncan" }, "act1-scene1");
  await wg.addRelation("ent-macbeth", "ent-inverness", "located_in", "act1-scene1");
  await wg.inferVisibility("act1-scene1");
  const decl = (await wg.getEntityAt("ent-inverness", "act1-scene1"))!.properties[0];
  const afterFirst = await wg.getVisibilityForDeclaration(decl.declarationId);
  await wg.inferVisibility("act1-scene1");
  const afterSecond = await wg.getVisibilityForDeclaration(decl.declarationId);
  assert.equal(afterFirst.length, 1, "首次推断应写入一条可见性");
  assert.equal(afterSecond.length, 1, "重复推断不应新增可见性记录");
}));

test("inferVisibility 撤销后再次推断不回填到撤销区间之前", withTempWg(async (wg) => {
  await wg.birthEntity("ent-macbeth", "character", {}, "act1-scene1");
  await wg.birthEntity("ent-inverness", "location", { visitor: "Duncan" }, "act1-scene1");
  await wg.addRelation("ent-macbeth", "ent-inverness", "located_in", "act1-scene1");
  await wg.inferVisibility("act1-scene1");
  const decl = (await wg.getEntityAt("ent-inverness", "act1-scene1"))!.properties[0];
  await wg.closeVisibility("ent-macbeth", decl.declarationId, "act1-scene2");
  assert.equal(
    (await wg.getVisibilityForCharacter("ent-macbeth", "act1-scene2")).length,
    0,
    "撤销时刻该声明应不可见",
  );
  await wg.inferVisibility("act1-scene3");
  const reopened = await wg.getVisibilityForCharacter("ent-macbeth", "act1-scene3");
  assert.equal(reopened.length, 1, "再次推断应恢复可见");
  assert.equal(reopened[0].validFrom, "act1-scene3", "validFrom 应取当前推断时刻而非撤销前");
  assert.equal(
    (await wg.getVisibilityForCharacter("ent-macbeth", "act1-scene2")).length,
    0,
    "新记录不得覆盖撤销区间",
  );
  const history = await wg.getVisibilityForDeclaration(decl.declarationId);
  assert.equal(history.length, 2, "历史应为 1 条闭合 + 1 条新开");
}));

// ============================================================================
// C3 台账修复（2026-08-07）：幂等写入入口
// ============================================================================

test("C3: setVisibilityIfAbsent 重复调用不产生重复记录", withTempWg(async (wg) => {
  await wg.birthEntity("e1", "character", { name: "甲" }, "t1");
  const declId = "decl-e1-name-t1";
  const visOpts = {
    state: "known" as const,
    confidence: 1,
    source: "experienced" as const,
    validFrom: "t1",
    isExplicit: true,
  };
  await wg.setVisibilityIfAbsent("e1", declId, visOpts);
  // 重复调用：幂等跳过，不抛错
  await assert.doesNotReject(wg.setVisibilityIfAbsent("e1", declId, visOpts));
  const all = await wg.getVisibilityForDeclaration(declId);
  assert.equal(all.length, 1, "重复 IfAbsent 不应产生第二条未闭合 Visibility");
  // 闭合后可再次写入（只挡"已有未闭合"的情况）
  await wg.closeVisibility("e1", declId, "t2");
  await wg.setVisibilityIfAbsent("e1", declId, { ...visOpts, validFrom: "t3" });
  const history = await wg.getVisibilityForDeclaration(declId);
  assert.equal(history.length, 2, "闭合后应允许新记录");
}));

// ============================================================================
// C4 台账修复（2026-08-07）：可选引用完整性校验（strict 模式）
// ============================================================================

test("C4: setVisibility strict=true 时 declarationId 不存在抛错", withTempWg(async (wg) => {
  const visOpts = {
    state: "known" as const,
    confidence: 1,
    source: "informed" as const,
    validFrom: "t1",
    isExplicit: true,
  };
  await assert.rejects(
    wg.setVisibility("e1", "decl-ghost", visOpts, { strict: true }),
    /decl-ghost/,
    "strict 模式下孤儿 Visibility 应抛错",
  );
  // strict 缺省：保持原行为（允许孤儿可见性）
  await assert.doesNotReject(wg.setVisibility("e1", "decl-ghost", visOpts));
}));
