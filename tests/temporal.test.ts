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
    newFacts: [{ entityId: "e-caiye", property: "mood", value: "sad", modality: "fact" }],
  });

  // 单时态（现行行为）：ch002 时刻 mood=sad
  const live = await wg.getEntityAt("e-caiye", "ch002.ev001");
  assert.equal(live?.properties.find((p) => p.property === "mood")?.value, "sad");

  // 双时态：ch002 时刻，但只含改写前写入的内容 → mood=happy 且未闭合
  const asWas = await wg.getEntityAt("e-caiye", "ch002.ev001", { recordedAsOf: before });
  const mood = asWas?.properties.find((p) => p.property === "mood");
  assert.equal(mood?.value, "happy");
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
    newFacts: [{ entityId: "e-lin", property: "weapon", value: "枪", modality: "fact" }],
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
    newFacts: [{ entityId: "e-lin", property: "birthplace", value: "东京", modality: "fact" }],
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

test("processEvent 自动填充 recordedAt（事务时间墙钟）", withTempWg(async (wg) => {
  await wg.processEvent({
    eventId: "evt-1",
    type: "birth",
    storyTime: "ch001.ev001",
    entityId: "e1",
  });
  const events = await wg.getAllEvents();
  assert.ok(events[0].recordedAt, "recordedAt 应自动填充");
  assert.ok(!Number.isNaN(Date.parse(events[0].recordedAt!)), "recordedAt 应为 ISO 时间");
  // 显式传入优先
  await wg.processEvent({
    eventId: "evt-2",
    type: "death",
    storyTime: "ch002.ev001",
    entityId: "e1",
    recordedAt: "2026-01-01T00:00:00.000Z",
  });
  const all = await wg.getAllEvents();
  assert.equal(all[1].recordedAt, "2026-01-01T00:00:00.000Z");
}));

test("getEntityHistory 附带写入时间（createdAt/updatedAt）", withTempWg(async (wg) => {
  await wg.birthEntity("e1", "character", { mood: "happy" }, "ch001.ev001");
  await wg.processEvent({
    eventId: "evt-1",
    type: "change",
    storyTime: "ch002.ev001",
    entityId: "e1",
    invalidated: [{ declarationId: "decl-e1-mood-ch001.ev001", property: "mood" }],
    newFacts: [{ entityId: "e1", property: "mood", value: "sad", modality: "fact" }],
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
