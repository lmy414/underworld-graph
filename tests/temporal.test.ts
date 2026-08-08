import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorldGraph } from "../src/world-graph.js";

function withTempWg(fn: (wg: WorldGraph, dir: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "wg-temporal-"));
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

test("recordedNow：空图 undefined；写入后返回可比较坐标", withTempWg(async (wg) => {
  assert.equal(await wg.recordedNow(), undefined);
  await wg.birthEntity("e1", "character", {}, "ch001.ev001");
  const now = await wg.recordedNow();
  assert.ok(now, "写入后应有坐标");
  assert.match(now!, /^r1:\d{16}:/, "坐标形如 r1:{revision}:{isoWallTime}");
  const later = await wg.recordedNow();
  assert.ok(later! >= now!, "坐标随写入单调不减");
}));

test("双时态实体快照：recordedAsOf 隔离后续改写（retcon 隔离）", withTempWg(async (wg) => {
  // ch001：彩叶 mood=happy
  await wg.birthEntity("e-caiye", "character", { mood: "happy" }, "ch001.ev001");
  const before = await wg.recordedNow();

  // ch002：mood 改写为 sad（happy 的 Fact 被闭合）
  await wg.processEvent({
    eventId: "evt-1",
    type: "change",
    storyTime: "ch002.ev001",
    entityId: "e-caiye",
    invalidated: [{ declarationId: "decl-e-caiye-mood-ch001.ev001", property: "mood" }],
    newFacts: [{ entityId: "e-caiye", property: "mood", description: "sad", modality: "fact" }],
  });

  // 单时态（现行行为）：ch002 时刻 mood=sad
  const live = await wg.getEntityAt("e-caiye", "ch002.ev001");
  assert.equal(live?.properties.find((p) => p.property === "mood")?.description, "sad");

  // 双时态：ch002 时刻，但只含改写前写入的内容 → mood=happy 且未闭合
  const asWas = await wg.getEntityAt("e-caiye", "ch002.ev001", { recordedAsOf: before });
  const mood = asWas?.properties.find((p) => p.property === "mood");
  assert.equal(mood?.description, "happy");
  assert.equal(mood?.validTo, "Infinity");
}));

test("双时态角色视角：后补写的历史 Fact 对 recordedAsOf 不可见", withTempWg(async (wg) => {
  await wg.birthEntity("e-lin", "character", { name: "林冲" }, "ch001.ev001");
  // 正常声明 + 可见性
  await wg.processEvent({
    eventId: "evt-1",
    type: "change",
    storyTime: "ch001.ev002",
    entityId: "e-lin",
    newFacts: [{ entityId: "e-lin", property: "weapon", description: "枪", modality: "fact" }],
  });
  await wg.setVisibility("e-lin", "decl-e-lin-weapon-ch001.ev002", {
    state: "known", confidence: 1, source: "experienced", validFrom: "ch001.ev002", isExplicit: true,
  });
  const before = await wg.recordedNow();

  // retcon：后来才补写一条故事时间更早的 Fact（validFrom 在过去）
  await wg.processEvent({
    eventId: "evt-2",
    type: "change",
    storyTime: "ch001.ev001",
    entityId: "e-lin",
    newFacts: [{ entityId: "e-lin", property: "birthplace", description: "东京", modality: "fact" }],
  });
  await wg.setVisibility("e-lin", "decl-e-lin-birthplace-ch001.ev001", {
    state: "known", confidence: 1, source: "informed", validFrom: "ch001.ev003", isExplicit: true,
  });

  // 单时态：ch001.ev003 时刻两条都可见（含 retcon）
  const live = await wg.getCharacterView("e-lin", "ch001.ev003");
  assert.ok(live.some((d) => d.property === "weapon"));
  assert.ok(live.some((d) => d.property === "birthplace"), "单时态下 retcon 可见");

  // 双时态：recordedAsOf=before → retcon 不可见，正常声明不受影响
  const asWas = await wg.getCharacterView("e-lin", "ch001.ev003", { recordedAsOf: before });
  assert.ok(asWas.some((d) => d.property === "weapon"));
  assert.ok(!asWas.some((d) => d.property === "birthplace"), "recordedAsOf 应隔离后补写的 Fact");
}));

test("processEvent 自动填充 recordedAt（D8：SDK 事务时钟坐标）", withTempWg(async (wg) => {
  // D8（2026-08-07）：recordedAt 缺省值从墙钟 ISO 改为 SDK recorded 坐标。
  // 空图首次写入无坐标，recordedAt 缺省不落
  await wg.processEvent({
    eventId: "evt-0",
    type: "birth",
    storyTime: "ch000.ev001",
    entityId: "e0",
  });
  const first = await wg.getAllEvents();
  assert.equal(first[0].recordedAt, undefined, "空图首次写入无 recorded 坐标，recordedAt 不落");

  // 有提交历史后，缺省 recordedAt 为 SDK recorded 坐标格式（非 ISO 墙钟）
  await wg.processEvent({
    eventId: "evt-1",
    type: "birth",
    storyTime: "ch001.ev001",
    entityId: "e1",
  });
  const events = await wg.getAllEvents();
  const e1 = events.find((e) => e.eventId === "evt-1");
  assert.ok(e1?.recordedAt, "recordedAt 应自动填充");
  assert.match(e1!.recordedAt!, /^r1:\d{16}:/, "recordedAt 应为 SDK recorded 坐标（非 ISO）");
  assert.ok(Number.isNaN(Date.parse(e1!.recordedAt!)), "recordedAt 不应是 ISO 墙钟");

  // 显式传入优先
  await wg.processEvent({
    eventId: "evt-2",
    type: "death",
    storyTime: "ch002.ev001",
    entityId: "e1",
    recordedAt: "2026-01-01T00:00:00.000Z",
  });
  const all = await wg.getAllEvents();
  assert.equal(all.find((e) => e.eventId === "evt-2")?.recordedAt, "2026-01-01T00:00:00.000Z");
}));

test("getEntityHistory 附带写入时间（createdAt/updatedAt）", withTempWg(async (wg) => {
  await wg.birthEntity("e1", "character", { mood: "happy" }, "ch001.ev001");
  await wg.processEvent({
    eventId: "evt-1",
    type: "change",
    storyTime: "ch002.ev001",
    entityId: "e1",
    invalidated: [{ declarationId: "decl-e1-mood-ch001.ev001", property: "mood" }],
    newFacts: [{ entityId: "e1", property: "mood", description: "sad", modality: "fact" }],
  });
  const { facts } = await wg.getEntityHistory("e1");
  const closed = facts.find((f) => f.declarationId === "decl-e1-mood-ch001.ev001");
  assert.ok(closed?.createdAt, "应含 createdAt");
  assert.ok(closed?.updatedAt, "应含 updatedAt");
  assert.ok(closed!.updatedAt! >= closed!.createdAt!, "闭合时间 >= 创建时间");
}));

test("双时态关系查询：recordedAsOf 隔离后续闭合", withTempWg(async (wg) => {
  await wg.birthEntity("e-a", "character", {}, "ch001.ev001");
  await wg.birthEntity("e-b", "character", {}, "ch001.ev001");
  await wg.addRelation("e-a", "e-b", "朋友", "ch001.ev002");
  const before = await wg.recordedNow();
  await wg.closeRelation("e-a", "e-b", "朋友", "ch002.ev001");

  // 单时态：ch002 时刻关系已闭合
  const live = await wg.getRelations("e-a", "ch002.ev001");
  assert.equal(live.length, 0);
  // 双时态：闭合前的写入时点看，关系仍在
  const asWas = await wg.getRelations("e-a", "ch002.ev001", { recordedAsOf: before });
  assert.equal(asWas.length, 1);
  assert.equal(asWas[0].label, "朋友");
}));

// ============================================================================
// C2 台账修复（2026-08-07）：history 方法补 recordedAsOf（retcon 隔离）
// ============================================================================

test("C2: getEntityHistory 带 recordedAsOf 隔离后续写入", withTempWg(async (wg) => {
  await wg.birthEntity("e1", "character", { mood: "happy" }, "ch001.ev001");
  const before = await wg.recordedNow();
  // retcon：闭合 mood=happy，改写为 sad
  await wg.processEvent({
    eventId: "evt-1",
    type: "change",
    storyTime: "ch002.ev001",
    entityId: "e1",
    invalidated: [{ declarationId: "decl-e1-mood-ch001.ev001", property: "mood" }],
    newFacts: [{ entityId: "e1", property: "mood", description: "sad", modality: "fact" }],
  });
  // live：两条 Fact（happy 已闭合 + sad）
  const live = await wg.getEntityHistory("e1");
  assert.equal(live.facts.length, 2);
  assert.equal(
    live.facts.find((f) => f.declarationId === "decl-e1-mood-ch001.ev001")?.validTo,
    "ch002.ev001",
  );
  // recordedAsOf=before：改写前的历史 —— happy 未闭合，sad 不存在
  const asWas = await wg.getEntityHistory("e1", { recordedAsOf: before });
  assert.equal(asWas.facts.length, 1, "recordedAsOf 应隔离后续补写的 Fact");
  assert.equal(asWas.facts[0].description, "happy");
  assert.equal(asWas.facts[0].validTo, "Infinity", "recordedAsOf 时点 happy 尚未闭合");
}));

test("C2: getRelationHistory 带 recordedAsOf 隔离后续闭合", withTempWg(async (wg) => {
  await wg.birthEntity("e-a", "character", {}, "ch001.ev001");
  await wg.birthEntity("e-b", "character", {}, "ch001.ev001");
  await wg.addRelation("e-a", "e-b", "朋友", "ch001.ev002");
  const before = await wg.recordedNow();
  await wg.closeRelation("e-a", "e-b", "朋友", "ch002.ev001");
  // live：关系已闭合
  const live = await wg.getRelationHistory("e-a");
  assert.equal(live[0]?.validTo, "ch002.ev001");
  // recordedAsOf=before：闭合前的时点看，关系未闭合
  const asWas = await wg.getRelationHistory("e-a", { recordedAsOf: before });
  assert.equal(asWas.length, 1);
  assert.equal(asWas[0].validTo, "Infinity", "recordedAsOf 时点关系尚未闭合");
}));

test("C2: getVisibilityForDeclaration 带 recordedAsOf 隔离后续撤销", withTempWg(async (wg) => {
  await wg.birthEntity("e1", "character", { name: "甲" }, "ch001.ev001");
  await wg.setVisibility("e1", "decl-e1-name-ch001.ev001", {
    state: "known", confidence: 1, source: "experienced", validFrom: "ch001.ev001", isExplicit: true,
  });
  const before = await wg.recordedNow();
  await wg.closeVisibility("e1", "decl-e1-name-ch001.ev001", "ch002.ev001");
  // live：可见性已撤销
  const live = await wg.getVisibilityForDeclaration("decl-e1-name-ch001.ev001");
  assert.equal(live[0]?.validTo, "ch002.ev001");
  // recordedAsOf=before：撤销前的时点看，可见性未闭合
  const asWas = await wg.getVisibilityForDeclaration("decl-e1-name-ch001.ev001", undefined, { recordedAsOf: before });
  assert.equal(asWas.length, 1);
  assert.equal(asWas[0].validTo, "Infinity", "recordedAsOf 时点可见性尚未撤销");
}));

test("C2: inferVisibility 带 recordedAsOf 不读取后补写的关系", withTempWg(async (wg) => {
  await wg.birthEntity("e-lin", "character", {}, "ch001.ev001");
  await wg.birthEntity("e-room", "location", { temp: "cold" }, "ch001.ev001");
  const before = await wg.recordedNow();  // 此时还没有 located_in 关系
  // 后补写关系（validFrom 在过去，但写入了 before 之后）
  await wg.addRelation("e-lin", "e-room", "located_in", "ch001.ev001");
  // recordedAsOf=before：关系对该时点不可见 → 不推断任何可见性
  await wg.inferVisibility("ch001.ev001", { recordedAsOf: before });
  const none = await wg.getVisibilityForDeclaration("decl-e-room-temp-ch001.ev001");
  assert.equal(none.length, 0, "recordedAsOf 应隔离后补写的关系，不做推断");
  // live：正常推断
  await wg.inferVisibility("ch001.ev001");
  const some = await wg.getVisibilityForDeclaration("decl-e-room-temp-ch001.ev001");
  assert.equal(some.length, 1, "live 推断应正常写入可见性");
}));
