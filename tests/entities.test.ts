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
  assert.equal(titleDecl.description, "Thane of Glamis");
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

test("0.3.0: birthEntity 非 string 值抛错（description string 契约，不做任意类型兼容）", withTempWg(async (wg) => {
  await assert.rejects(
    wg.birthEntity("ent-a", "character", { inventory: { weapon: "sword" } }, "t1"),
    /必须是 string/,
    "0.3.0 起 initialProps 值域收窄为 string，对象值应显式抛错而非 [object Object] 垃圾",
  );
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

// ============================================================================
// D2/D3 台账修复（2026-08-07）：birthEntity 公开 API extraFacts 参数
// ============================================================================

test("D2/D3: birthEntity extraFacts 逐条写 Fact，与 initialProps 合并计数声明 ID", withTempWg(async (wg) => {
  await wg.birthEntity("e1", "character", { tag: "a" }, "t1", undefined, [
    { entityId: "e1", property: "tag", description: "b" },
    { entityId: "e1", property: "tag", description: "c", modality: "belief" },
  ]);
  const snap = await wg.getEntityAt("e1", "t1");
  const tags = snap!.properties.filter((d) => d.property === "tag");
  assert.equal(tags.length, 3, "initialProps 与 extraFacts 同 property 应全部保留");
  const ids = tags.map((d) => d.declarationId).sort();
  assert.deepEqual(ids, ["decl-e1-tag-t1", "decl-e1-tag-t1-2", "decl-e1-tag-t1-3"]);
  // extraFacts modality 透传（缺省 "fact"）
  const belief = tags.find((d) => d.description === "c");
  assert.equal(belief?.modality, "belief");
  const second = tags.find((d) => d.description === "b");
  assert.equal(second?.modality, "fact", "extraFacts modality 缺省应为 fact");
}));

// ============================================================================
// D4 台账修复（2026-08-07）：killEntity 级联闭合 Relation
// ============================================================================

test("D4: killEntity 级联闭合死者所有未闭合 Relation", withTempWg(async (wg) => {
  await wg.birthEntity("ent-a", "character", {}, "t1");
  await wg.birthEntity("ent-b", "location", {}, "t1");
  await wg.birthEntity("ent-c", "character", {}, "t1");
  await wg.addRelation("ent-a", "ent-b", "located_in", "t1");  // a 为 source
  await wg.addRelation("ent-c", "ent-a", "knows", "t1");       // a 为 target
  await wg.addRelation("ent-b", "ent-c", "near", "t1");        // 与 a 无关
  await wg.killEntity("ent-a", "t2");
  // getRelations 在 t2 查不到死者关系（both source/target 方向）
  const after = await wg.getRelations("ent-a", "t2");
  assert.equal(after.length, 0, "死后 Relation 应全部闭合");
  const before = await wg.getRelations("ent-a", "t1");
  assert.equal(before.length, 2, "死前 Relation 应可查");
  // getRelationHistory 能查到已闭合记录
  const history = await wg.getRelationHistory("ent-a");
  assert.equal(history.length, 2);
  assert.ok(history.every((r) => r.validTo === "t2"), "历史中死者 Relation validTo 应为死亡时刻");
  // 与死者无关的关系不受影响
  const untouched = await wg.getRelations("ent-b", "t2");
  assert.ok(untouched.some((r) => r.label === "near"), "无关 Relation 不应被级联闭合");
}));

// ============================================================================
// D5 台账修复（2026-08-07）：updateEntitySummary 写事件 + 重嵌入
// ============================================================================

test("D5: updateEntitySummary 更新生效且产生 change 事件", withTempWg(async (wg) => {
  await wg.birthEntity("e1", "character", {}, "t1");
  await wg.updateEntitySummary("e1", "新摘要", "t2");
  const snap = await wg.getEntityAt("e1", "t2");
  assert.equal(snap?.summary, "新摘要", "summary 覆盖更新应生效");
  const events = await wg.getAllEvents();
  const evt = events.find((e) => e.type === "change" && e.entityId === "e1");
  assert.ok(evt, "应写一条 change 事件到事件日志（summary 变更可回溯）");
  assert.equal(evt!.summary, "新摘要", "事件复用 summary 字段");
  assert.equal(evt!.storyTime, "t2");
  assert.equal(evt!.source, "engine", "source 默认 engine");
  assert.equal(evt!.newFacts, undefined, "newFacts 为空");
  assert.equal(evt!.invalidated, undefined, "invalidated 为空");
}));

test("D5: updateEntitySummary 配置 embedder 时触发重嵌入", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wg-test-"));
  const embedded: string[] = [];
  const wg = await WorldGraph.create({
    dbPath: join(dir, "world.db"),
    eventLogPath: join(dir, "events.jsonl"),
    embedder: {
      embedEntity: async (snap) => { embedded.push(snap.entityId); return new Array(512).fill(0); },
      embedFact: async () => new Array(512).fill(0),
    },
  });
  try {
    await wg.birthEntity("e1", "character", {}, "t1");
    await wg.updateEntitySummary("e1", "触发重嵌入", "t2");
    assert.deepEqual(embedded, ["e1"], "配置 embedder 时应触发该实体的重嵌入");
  } finally {
    wg.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// C3 台账修复（2026-08-07）：幂等写入入口
// ============================================================================

test("C3: birthEntityUpsert 重复调用不产生重复记录", withTempWg(async (wg) => {
  await wg.birthEntityUpsert("e1", "character", { name: "甲" }, "t1");
  // 重复调用：幂等跳过，不抛错
  await assert.doesNotReject(wg.birthEntityUpsert("e1", "character", { name: "乙" }, "t2"));
  const snap = await wg.getEntityAt("e1", "t1");
  assert.equal(snap?.properties.find((d) => d.property === "name")?.description, "甲", "首次写入保留");
  const { entities } = await wg.getEntityHistory("e1");
  assert.equal(entities.length, 1, "重复 upsert 不应产生第二条 Entity 记录");
}));

// ============================================================================
// C4 台账修复（2026-08-07）：可选引用完整性校验（strict 模式）
// ============================================================================

test("C4: birthEntity strict=true 时 entityId 已存活抛错", withTempWg(async (wg) => {
  await wg.birthEntity("e1", "character", {}, "t1");
  await assert.rejects(
    wg.birthEntity("e1", "character", {}, "t2", undefined, undefined, { strict: true }),
    /已存活/,
    "strict 模式下重复诞生应抛错",
  );
  // strict 缺省：保持原行为（不抛错）
  await assert.doesNotReject(wg.birthEntity("e1", "character", {}, "t2"));
}));

test("C4: addRelation strict=true 时端点实体不存在抛错", withTempWg(async (wg) => {
  await wg.birthEntity("e1", "character", {}, "t1");
  await assert.rejects(
    wg.addRelation("e1", "e-ghost", "knows", "t1", { strict: true }),
    /e-ghost/,
    "strict 模式下端点缺失应抛错",
  );
  // strict 缺省：保持原行为（允许孤儿关系）
  await assert.doesNotReject(wg.addRelation("e1", "e-ghost", "knows", "t1"));
}));

test("D5: updateEntitySummary 同毫秒重复调用事件 ID 不撞键（复核修复）", withTempWg(async (wg) => {
  await wg.birthEntity("e1", "character", {}, "t1");
  // 同 storyTime 连续两次调用（极可能同毫秒），eventId 靠实例级自增序号区分
  await wg.updateEntitySummary("e1", "摘要一", "t2");
  await wg.updateEntitySummary("e1", "摘要二", "t2");
  const evts = (await wg.getAllEvents()).filter(
    (e) => e.type === "change" && e.entityId === "e1",
  );
  assert.equal(evts.length, 2, "两次调用应各产生一条 change 事件");
  assert.notEqual(evts[0].eventId, evts[1].eventId, "同毫秒调用 eventId 应唯一");
  // traceCauses 按 eventId 索引，撞键会互相覆盖；此处验证两条都可独立回溯
  assert.equal((await wg.traceCauses(evts[0].eventId))?.[0].summary, "摘要一");
  assert.equal((await wg.traceCauses(evts[1].eventId))?.[0].summary, "摘要二");
}));

// ============================================================================
// 0.3.0 字段补全：Entity.name/aliases 快照 + Relation.description
// （计划 field-redesign-plan-2026-08-08 §二，2026-08-08）
// ============================================================================

test("0.3.0: birthEntity 含「名字」property 时 Entity.name 快照写入", withTempWg(async (wg) => {
  await wg.birthEntity("ent-caiye", "character", { 名字: "酒寄彩叶", 心情: "好奇" }, "ch001.ev001");
  const snap = await wg.getEntityAt("ent-caiye", "ch001.ev001");
  assert.ok(snap);
  assert.equal(snap.name, "酒寄彩叶", "Entity.name 快照应取自「名字」property");
  assert.deepEqual(snap.aliases, [], "0.3.0 别名快照无来源，缺省空数组");
  // 快照字段同时出现在 getAllEntities / getEntityHistory
  const all = await wg.getAllEntities("ch001.ev001");
  assert.equal(all.find((e) => e.entityId === "ent-caiye")?.name, "酒寄彩叶");
  const { entities } = await wg.getEntityHistory("ent-caiye");
  assert.equal(entities[0].name, "酒寄彩叶");
  assert.deepEqual(entities[0].aliases, []);
}));

test("0.3.0: birth 事件 newFacts 含「名字」时 Entity.name 快照写入（extraFacts 兜底）", withTempWg(async (wg) => {
  await wg.processEvent({
    eventId: "evt-birth-name",
    type: "birth",
    storyTime: "ch001.ev001",
    entityId: "e-hero",
    newFacts: [{ entityId: "e-hero", property: "名字", description: "星野铃", modality: "fact" }],
  });
  const snap = await wg.getEntityAt("e-hero", "ch001.ev001");
  assert.equal(snap?.name, "星野铃", "birth 事件路径也应写 name 快照");
}));

test("0.3.0: 改名 change 事件（property=名字）同步更新 Entity.name 快照", withTempWg(async (wg) => {
  await wg.birthEntity("ent-caiye", "character", { 名字: "酒寄彩叶" }, "ch001.ev001");
  await wg.processEvent({
    eventId: "evt-rename",
    type: "change",
    storyTime: "ch002.ev001",
    entityId: "ent-caiye",
    invalidated: [{ declarationId: "decl-ent-caiye-名字-ch001.ev001", property: "名字" }],
    newFacts: [{ entityId: "ent-caiye", property: "名字", description: "彩叶", modality: "fact" }],
  });
  const snap = await wg.getEntityAt("ent-caiye", "ch002.ev001");
  assert.equal(snap?.name, "彩叶", "改名事件应同步 Entity.name 展示快照（与 updateEntitySummary 同模式）");
  // 非「名字」property 不影响快照
  await wg.processEvent({
    eventId: "evt-mood",
    type: "change",
    storyTime: "ch003.ev001",
    entityId: "ent-caiye",
    newFacts: [{ entityId: "ent-caiye", property: "心情", description: "愤怒", modality: "fact" }],
  });
  const snap2 = await wg.getEntityAt("ent-caiye", "ch003.ev001");
  assert.equal(snap2?.name, "彩叶", "非名字 property 变更不应改 name 快照");
}));

test("0.3.0: addRelation 携带 description（label 收窄后长句描述归位）", withTempWg(async (wg) => {
  await wg.birthEntity("ent-a", "character", {}, "t1");
  await wg.birthEntity("ent-b", "character", {}, "t1");
  await wg.addRelation("ent-a", "ent-b", "朋友", "t1", {
    description: "KASSEN 游戏中的对手，现实初次见面",
  });
  const rels = await wg.getRelations("ent-a", "t1");
  assert.equal(rels[0].label, "朋友", "label 保持简单类型词");
  assert.equal(rels[0].description, "KASSEN 游戏中的对手，现实初次见面");
  // 未传 description 时缺省空串
  await wg.addRelation("ent-a", "ent-b", "认识", "t2");
  const rels2 = await wg.getRelations("ent-a", "t2");
  assert.equal(rels2.find((r) => r.label === "认识")?.description, "");
  // 历史查询同样带 description
  const history = await wg.getRelationHistory("ent-a");
  assert.equal(history.find((r) => r.label === "朋友")?.description, "KASSEN 游戏中的对手，现实初次见面");
}));
