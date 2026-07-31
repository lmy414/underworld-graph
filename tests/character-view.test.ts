import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorldGraph } from "../src/world-graph.js";

function withTempWg(fn: (wg: WorldGraph) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "wg-cv-"));
    const wg = await WorldGraph.create({
      dbPath: join(dir, "world.db"),
      eventLogPath: join(dir, "events.jsonl"),
    });
    try { await fn(wg); } finally { wg.close(); rmSync(dir, { recursive: true, force: true }); }
  };
}

test("characterView 返回角色已知声明（飞书文档步骤 8 Macbeth 示例）", withTempWg(async (wg) => {
  await wg.birthEntity("ent-macbeth", "character", { title: "Thane" }, "act1-scene1");
  await wg.birthEntity("ent-inverness", "location", { temp: "cold" }, "act1-scene1");
  await wg.addRelation("ent-macbeth", "ent-inverness", "located_in", "act1-scene1");
  await wg.processEvent({
    eventId: "evt-duncan-visit",
    type: "change",
    storyTime: "act1-scene4",
    entityId: "ent-inverness",
    newFacts: [{ entityId: "ent-inverness", property: "visitor", value: "Duncan", modality: "fact" }],
  });
  await wg.inferVisibility("act1-scene4");
  const view = await wg.getCharacterView("ent-macbeth", "act1-scene4", { modalityFilter: ["fact"] });
  const visitorDecl = view.find((d: any) => d.property === "visitor");
  assert.ok(visitorDecl, "Macbeth 应通过 located_in 推断看到 Inverness 的 visitor 声明");
  assert.equal(visitorDecl.value, "Duncan");
}));

test("characterView 角色无可见性声明时返回空", withTempWg(async (wg) => {
  await wg.birthEntity("ent-macbeth", "character", {}, "act1-scene1");
  await wg.birthEntity("ent-duncan", "character", { status: "alive" }, "act1-scene1");
  const view = await wg.getCharacterView("ent-macbeth", "act1-scene1");
  assert.equal(view.length, 0);
}));

test("characterView modalityFilter 过滤", withTempWg(async (wg) => {
  await wg.birthEntity("ent-macbeth", "character", {}, "act1-scene1");
  await wg.processEvent({
    eventId: "evt-belief",
    type: "change",
    storyTime: "act1-scene2",
    entityId: "ent-macbeth",
    invalidated: [],
    newFacts: [{ entityId: "ent-macbeth", property: "believes_prophecy", value: true, modality: "belief" }],
  });
  const snap2 = await wg.getEntityAt("ent-macbeth", "act1-scene2");
  for (const d of snap2!.properties) {
    await wg.setVisibility("ent-macbeth", d.declarationId, {
      state: "known", confidence: 1, source: "experienced",
      validFrom: "act1-scene1", isExplicit: true,
    });
  }
  const onlyFact = await wg.getCharacterView("ent-macbeth", "act1-scene2", { modalityFilter: ["fact"] });
  const onlyBelief = await wg.getCharacterView("ent-macbeth", "act1-scene2", { modalityFilter: ["belief"] });
  assert.ok(onlyFact.every((d: any) => d.modality === "fact"));
  assert.ok(onlyBelief.every((d: any) => d.modality === "belief"));
}));

test("characterView 知识持续：声明闭合后仍可见，直到可见性被撤销", withTempWg(async (wg) => {
  await wg.birthEntity("ent-master", "character", { role: "长老" }, "act1-scene1");
  await wg.birthEntity("ent-hero", "character", {}, "act1-scene1");
  // hero 在 scene2 得知师父身份（rumor）
  await wg.setVisibility("ent-hero", "decl-ent-master-role-act1-scene1", {
    state: "known", confidence: 0.5, source: "informed",
    validFrom: "act1-scene2", isExplicit: true,
  });
  // scene3 师父死亡，级联闭合其所有声明
  await wg.killEntity("ent-master", "act1-scene3");
  // scene4（声明已闭合）：知识应仍可见
  const viewAfter = await wg.getCharacterView("ent-hero", "act1-scene4");
  const known = viewAfter.find((d: any) => d.declarationId === "decl-ent-master-role-act1-scene1");
  assert.ok(known, "声明闭合后知识仍应可见（知识持续语义）");
  assert.equal(known.value, "长老");
  // 撤销可见性后：不再可见
  await wg.closeVisibility("ent-hero", "decl-ent-master-role-act1-scene1", "act1-scene5");
  const viewRevoked = await wg.getCharacterView("ent-hero", "act1-scene6");
  assert.equal(
    viewRevoked.find((d: any) => d.declarationId === "decl-ent-master-role-act1-scene1"),
    undefined,
    "可见性撤销后不应再可见",
  );
}));
