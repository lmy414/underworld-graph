import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventLog } from "../src/event-log.js";
import { WorldGraph } from "../src/world-graph.js";

function withTempLog(fn: (log: EventLog, dir: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "wg-log-"));
    const log = new EventLog(join(dir, "events.jsonl"));
    try {
      await fn(log, dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function withTempWg(fn: (wg: WorldGraph, dir: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "wg-evt-"));
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

test("append + readAll", withTempLog(async (log) => {
  await log.append({ eventId: "evt-1", type: "birth", storyTime: "t1", entityId: "e1" });
  await log.append({ eventId: "evt-2", type: "change", storyTime: "t2", entityId: "e1", causedBy: "evt-1" });
  const all = await log.readAll();
  assert.equal(all.length, 2);
  assert.equal(all[0].eventId, "evt-1");
  assert.equal(all[1].causedBy, "evt-1");
}));

test("traceBack 沿 causedBy 回溯", withTempLog(async (log) => {
  await log.append({ eventId: "evt-a", type: "birth", storyTime: "t1", entityId: "e1" });
  await log.append({ eventId: "evt-b", type: "change", storyTime: "t2", entityId: "e1", causedBy: "evt-a" });
  await log.append({ eventId: "evt-c", type: "change", storyTime: "t3", entityId: "e1", causedBy: "evt-b" });
  const chain = await log.traceBack("evt-c");
  assert.deepEqual(chain.map((e: any) => e.eventId), ["evt-a", "evt-b", "evt-c"]);
}));

test("traceBack 无 causedBy 时返回单元素", withTempLog(async (log) => {
  await log.append({ eventId: "evt-x", type: "birth", storyTime: "t1", entityId: "e1" });
  const chain = await log.traceBack("evt-x");
  assert.equal(chain.length, 1);
  assert.equal(chain[0].eventId, "evt-x");
}));

test("traceBack causedBy 指向不存在的事件时停止", withTempLog(async (log) => {
  await log.append({ eventId: "evt-y", type: "change", storyTime: "t1", entityId: "e1", causedBy: "evt-missing" });
  const chain = await log.traceBack("evt-y");
  assert.equal(chain.length, 1);
  assert.equal(chain[0].eventId, "evt-y");
}));

test("readAll 跳过损坏行（容错，不丢全部日志）", withTempLog(async (log, dir) => {
  await log.append({ eventId: "evt-ok-1", type: "birth", storyTime: "t1", entityId: "e1" });
  appendFileSync(join(dir, "events.jsonl"), "not-json-line\n", "utf-8");
  await log.append({ eventId: "evt-ok-2", type: "change", storyTime: "t2", entityId: "e1", causedBy: "evt-ok-1" });
  const all = await log.readAll();
  assert.deepEqual(all.map((e) => e.eventId), ["evt-ok-1", "evt-ok-2"], "损坏行应被跳过");
}));

test("readAll 跳过形状不符的合法 JSON 行", withTempWg(async (wg, dir) => {
  await wg.processEvent({ eventId: "evt-ok-1", type: "birth", storyTime: "t1", entityId: "e1" });
  appendFileSync(join(dir, "events.jsonl"), '{"foo":"bar"}\n', "utf-8");
  await wg.processEvent({ eventId: "evt-ok-2", type: "change", storyTime: "t2", entityId: "e1" });
  const events = await wg.getAllEvents();
  assert.deepEqual(events.map((e) => e.eventId), ["evt-ok-1", "evt-ok-2"], "形状不符行应被跳过且 sort 不炸");
}));

test("processEvent DB 写入失败时事务回滚：状态不变、日志保留审计", withTempWg(async (wg) => {
  await wg.birthEntity("ent-a", "character", { status: "alive" }, "t1");
  await assert.rejects(
    wg.processEvent({
      eventId: "evt-death-missing",
      type: "death",
      storyTime: "t2",
      entityId: "ent-missing",
    }),
    /not found/,
    "对不存在实体 death 应抛错（killEntity 校验）",
  );
  const snap = await wg.getEntityAt("ent-a", "t2");
  assert.ok(snap, "既有实体状态不应被部分应用破坏");
  assert.equal(snap!.properties.find((d: any) => d.property === "status")?.value, "alive");
  const chain = await wg.traceCauses("evt-death-missing");
  assert.ok(chain, "失败事件仍留在 JSONL（因果链审计语义）");
  assert.equal(chain!.length, 1);
}));

test("processEvent type=birth 等价 birthEntity", withTempWg(async (wg) => {
  await wg.processEvent({
    eventId: "evt-birth-1",
    type: "birth",
    storyTime: "act1-scene1",
    entityId: "ent-macbeth",
    newFacts: [{ entityId: "ent-macbeth", property: "title", value: "Thane", modality: "fact" }],
  });
  const snap = await wg.getEntityAt("ent-macbeth", "act1-scene1");
  assert.ok(snap);
  assert.equal(snap.type, "character");  // birth 事件默认 character
}));

test("processEvent type=change 闭合旧声明 + 写入新声明", withTempWg(async (wg) => {
  await wg.birthEntity("ent-duncan", "character", { status: "alive" }, "act1-scene1");
  await wg.processEvent({
    eventId: "evt-change-1",
    type: "change",
    storyTime: "act2-scene2",
    entityId: "ent-duncan",
    invalidated: [{ declarationId: "decl-ent-duncan-status-act1-scene1", property: "status" }],
    newFacts: [{ entityId: "ent-duncan", property: "status", value: "dead", modality: "fact" }],
    causedBy: "evt-birth-1",
  });
  const before = await wg.getEntityAt("ent-duncan", "act2-scene1");
  const beforeStatus = before?.properties.find((d: any) => d.property === "status");
  assert.equal(beforeStatus?.value, "alive", "变更前应为 alive");
  const after = await wg.getEntityAt("ent-duncan", "act2-scene2");
  const afterStatus = after?.properties.find((d: any) => d.property === "status");
  assert.equal(afterStatus?.value, "dead", "变更后应为 dead");
}));

test("processEvent type=death 等价 killEntity", withTempWg(async (wg) => {
  await wg.birthEntity("ent-duncan", "character", {}, "act1-scene1");
  await wg.processEvent({
    eventId: "evt-death-1",
    type: "death",
    storyTime: "act2-scene2",
    entityId: "ent-duncan",
  });
  const after = await wg.getEntityAt("ent-duncan", "act2-scene2");
  assert.equal(after, null, "death 后应返回 null");
}));

test("processEvent 写入 JSONL 日志", withTempWg(async (wg, dir) => {
  await wg.processEvent({
    eventId: "evt-log-1",
    type: "birth",
    storyTime: "t1",
    entityId: "e1",
  });
  const chain = await wg.traceCauses("evt-log-1");
  assert.ok(chain);
  assert.equal(chain!.length, 1);
  assert.equal(chain![0].eventId, "evt-log-1");
}));

test("processEvent 持久化 userInput（用户口述原文）", withTempWg(async (wg) => {
  await wg.processEvent({
    eventId: "evt-ui-1",
    type: "change",
    storyTime: "ch001.ev001",
    entityId: "e1",
    newFacts: [{ entityId: "e1", property: "mood", value: "好奇", modality: "fact" }],
    userInput: "彩叶推开咖啡厅的门",
  });
  const events = await wg.getAllEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].userInput, "彩叶推开咖啡厅的门");
  // 无 userInput 的事件该字段为 undefined（可选字段不落默认值）
  await wg.processEvent({
    eventId: "evt-ui-2",
    type: "change",
    storyTime: "ch001.ev002",
    entityId: "e1",
  });
  const all = await wg.getAllEvents();
  assert.equal(all[1].userInput, undefined);
}));

// ============================================================================
// D2/D3 台账修复（2026-08-07）：birth 事件 newFacts 语义
// 弃用 Object.fromEntries（同 property 多条互相覆盖、f.entityId 被忽略、
// modality 硬编码 "fact"），改为逐条写 Fact
// ============================================================================

test("D2: birth 事件同 property 多条 newFacts 全部保留，声明 ID 首条旧格式次条 -2", withTempWg(async (wg) => {
  await wg.processEvent({
    eventId: "evt-birth-multi",
    type: "birth",
    storyTime: "ch001.ev001",
    entityId: "e-multi",
    newFacts: [
      { entityId: "e-multi", property: "alias", value: "甲", modality: "fact" },
      { entityId: "e-multi", property: "alias", value: "乙", modality: "fact" },
      { entityId: "e-multi", property: "alias", value: "丙", modality: "fact" },
    ],
  });
  const snap = await wg.getEntityAt("e-multi", "ch001.ev001");
  assert.ok(snap);
  const aliases = snap!.properties.filter((d) => d.property === "alias");
  assert.equal(aliases.length, 3, "同 property 多条 newFacts 应全部保留");
  const ids = aliases.map((d) => d.declarationId).sort();
  assert.deepEqual(ids, [
    "decl-e-multi-alias-ch001.ev001",    // 首条保持旧格式（存量 ID 稳定）
    "decl-e-multi-alias-ch001.ev001-2",  // 次条追加 -2
    "decl-e-multi-alias-ch001.ev001-3",
  ]);
  const values = aliases.map((d) => d.value).sort();
  assert.deepEqual(values, ["丙", "乙", "甲"]);
}));

test("D2: birth 事件跨实体 newFacts 落到正确实体", withTempWg(async (wg) => {
  await wg.birthEntity("e-other", "item", {}, "ch001.ev001");
  await wg.processEvent({
    eventId: "evt-birth-cross",
    type: "birth",
    storyTime: "ch001.ev002",
    entityId: "e-main",
    newFacts: [
      { entityId: "e-main", property: "name", value: "主角", modality: "fact" },
      { entityId: "e-other", property: "mark", value: "被标记", modality: "fact" },
    ],
  });
  // 跨实体声明落到 e-other（旧实现 f.entityId 被忽略，静默丢到主实体）
  const other = await wg.getEntityAt("e-other", "ch001.ev002");
  assert.equal(
    other?.properties.find((d) => d.property === "mark")?.value,
    "被标记",
    "跨实体 newFacts 应落到 f.entityId 指定的实体",
  );
  const main = await wg.getEntityAt("e-main", "ch001.ev002");
  assert.ok(!main?.properties.some((d) => d.property === "mark"), "主实体不应错挂 mark 声明");
}));

test("D3: birth 事件 newFacts modality 透传落库", withTempWg(async (wg) => {
  await wg.processEvent({
    eventId: "evt-birth-belief",
    type: "birth",
    storyTime: "ch001.ev001",
    entityId: "e-belief",
    newFacts: [
      { entityId: "e-belief", property: "motive", value: "复仇", modality: "belief" },
    ],
  });
  const snap = await wg.getEntityAt("e-belief", "ch001.ev001");
  const motive = snap?.properties.find((d) => d.property === "motive");
  assert.equal(motive?.modality, "belief", "birth newFacts 的 modality 应透传（旧实现硬编码 fact）");
}));

// ============================================================================
// D7 台账修复（2026-08-07）：traceCauses 语义区分
// eventId 不存在 → null；前驱丢失 → 抛错；正常链 → 完整链
// ============================================================================

test("D7: traceCauses eventId 不存在返回 null", withTempWg(async (wg) => {
  await wg.processEvent({ eventId: "evt-exists", type: "birth", storyTime: "t1", entityId: "e1" });
  const chain = await wg.traceCauses("evt-nonexistent");
  assert.equal(chain, null, "eventId 不存在应返回 null（区别于根因事件）");
}));

test("D7: traceCauses 悬空 causedBy 抛错且消息含悬空 eventId", withTempWg(async (wg, dir) => {
  await wg.processEvent({ eventId: "evt-real", type: "birth", storyTime: "t1", entityId: "e1" });
  // 手工 append 一条 causedBy 指向不存在事件的日志行（模拟前驱丢失）
  appendFileSync(
    join(dir, "events.jsonl"),
    JSON.stringify({ eventId: "evt-orphan", type: "change", storyTime: "t2", entityId: "e1", source: "engine", causedBy: "evt-dangling" }) + "\n",
    "utf-8",
  );
  await assert.rejects(
    wg.traceCauses("evt-orphan"),
    /evt-dangling/,
    "前驱丢失应抛错且消息含悬空 eventId",
  );
}));

test("D7: traceCauses 根因事件返回单元素链", withTempWg(async (wg) => {
  await wg.processEvent({ eventId: "evt-root", type: "birth", storyTime: "t1", entityId: "e1" });
  const chain = await wg.traceCauses("evt-root");
  assert.ok(chain);
  assert.equal(chain!.length, 1);
  assert.equal(chain![0].eventId, "evt-root");
}));

// ============================================================================
// C4 台账修复（2026-08-07）：processEvent 可选严格模式
// strict 只影响校验行为，不进 zod schema、不落日志
// ============================================================================

test("C4: processEvent strict=true 时孤儿 newFacts 抛错", withTempWg(async (wg) => {
  await wg.birthEntity("e-alive", "character", {}, "t1");
  await assert.rejects(
    wg.processEvent({
      eventId: "evt-strict-orphan",
      type: "change",
      storyTime: "t2",
      entityId: "e-alive",
      newFacts: [{ entityId: "e-ghost", property: "p", value: "v", modality: "fact" }],
      strict: true,
    }),
    /e-ghost/,
    "strict 模式下给不存在实体写 newFacts 应抛错",
  );
}));

test("C4: processEvent strict 缺省不校验，且 strict 不落事件日志", withTempWg(async (wg) => {
  // strict 缺省（false）：孤儿 newFacts 不抛错（原行为）
  await assert.doesNotReject(
    wg.processEvent({
      eventId: "evt-nonstrict-orphan",
      type: "change",
      storyTime: "t1",
      entityId: "e-x",
      newFacts: [{ entityId: "e-ghost", property: "p", value: "v", modality: "fact" }],
    }),
  );
  // strict=true 且引用存活实体：正常通过
  await wg.birthEntity("e-alive", "character", {}, "t1");
  await wg.processEvent({
    eventId: "evt-strict-ok",
    type: "change",
    storyTime: "t2",
    entityId: "e-alive",
    newFacts: [{ entityId: "e-alive", property: "p", value: "v", modality: "fact" }],
    strict: true,
  });
  const evt = (await wg.getAllEvents()).find((e) => e.eventId === "evt-strict-ok");
  assert.ok(evt);
  assert.ok(!("strict" in evt!), "strict 只影响校验行为，不应落事件日志");
}));

test("C4: processEvent birth strict=true 时实体已存活抛错，缺省不抛", withTempWg(async (wg) => {
  await wg.processEvent({ eventId: "evt-b1", type: "birth", storyTime: "t1", entityId: "e1" });
  // strict=true：重复 birth 抛错（复核修复：strict 透传到 birth 分支，不再静默吞掉）
  await assert.rejects(
    wg.processEvent({ eventId: "evt-b2", type: "birth", storyTime: "t2", entityId: "e1", strict: true }),
    /已存活/,
    "strict 模式下 birth 已存活实体应抛错",
  );
  // strict 缺省：保持原行为（不抛错）
  await assert.doesNotReject(
    wg.processEvent({ eventId: "evt-b3", type: "birth", storyTime: "t2", entityId: "e1" }),
  );
}));

test("C4: processEvent change strict=true 时 invalidated 悬空 declarationId 抛错，缺省静默跳过", withTempWg(async (wg) => {
  await wg.birthEntity("e1", "character", { mood: "happy" }, "t1");
  // strict=true：invalidated 引用不存在的 declarationId 抛错
  await assert.rejects(
    wg.processEvent({
      eventId: "evt-inv-ghost",
      type: "change",
      storyTime: "t2",
      entityId: "e1",
      invalidated: [{ declarationId: "decl-ghost", property: "mood" }],
      newFacts: [{ entityId: "e1", property: "mood", value: "sad", modality: "fact" }],
      strict: true,
    }),
    /decl-ghost/,
    "strict 模式下悬空 invalidated 应抛错",
  );
  // strict=true：invalidated 引用已闭合的 declarationId 也抛错
  await wg.processEvent({
    eventId: "evt-close-mood",
    type: "change",
    storyTime: "t2",
    entityId: "e1",
    invalidated: [{ declarationId: "decl-e1-mood-t1", property: "mood" }],
    newFacts: [{ entityId: "e1", property: "mood", value: "sad", modality: "fact" }],
  });
  await assert.rejects(
    wg.processEvent({
      eventId: "evt-inv-closed",
      type: "change",
      storyTime: "t3",
      entityId: "e1",
      invalidated: [{ declarationId: "decl-e1-mood-t1", property: "mood" }],
      strict: true,
    }),
    /已闭合/,
    "strict 模式下 invalidated 已闭合声明应抛错",
  );
  // strict 缺省：悬空 invalidated 静默跳过（现行为不变）
  await assert.doesNotReject(
    wg.processEvent({
      eventId: "evt-inv-skip",
      type: "change",
      storyTime: "t4",
      entityId: "e1",
      invalidated: [{ declarationId: "decl-ghost-2", property: "mood" }],
    }),
  );
}));

// ============================================================================
// D4 台账修复（2026-08-07）事务路径：processEvent type=death 级联闭合 Relation
// （tx 上下文下 source 与 target 两个方向均闭合）
// ============================================================================

test("D4: processEvent type=death 事务内级联闭合死者 Relation（source/target 双向）", withTempWg(async (wg) => {
  await wg.birthEntity("ent-a", "character", {}, "t1");
  await wg.birthEntity("ent-b", "location", {}, "t1");
  await wg.birthEntity("ent-c", "character", {}, "t1");
  await wg.addRelation("ent-a", "ent-b", "located_in", "t1");  // a 为 source
  await wg.addRelation("ent-c", "ent-a", "knows", "t1");       // a 为 target
  await wg.processEvent({
    eventId: "evt-death-a",
    type: "death",
    storyTime: "t2",
    entityId: "ent-a",
  });
  const after = await wg.getRelations("ent-a", "t2");
  assert.equal(after.length, 0, "death 事件后死者 Relation 应全部闭合");
  const history = await wg.getRelationHistory("ent-a");
  assert.equal(history.length, 2);
  assert.ok(history.every((r) => r.validTo === "t2"), "source/target 两个方向均应闭合于死亡时刻");
  const labels = history.map((r) => r.label).sort();
  assert.deepEqual(labels, ["knows", "located_in"]);
}));

// ============================================================================
// 收尾补丁（2026-08-07）：traceCauses 因果环保护 + strict invalidated property 一致性
// ============================================================================

test("D7: traceCauses 因果环抛错而非无限循环", withTempWg(async (wg, dir) => {
  // 手工 append 两条互指 causedBy 的日志行（模拟日志损坏产生因果环）
  appendFileSync(
    join(dir, "events.jsonl"),
    JSON.stringify({ eventId: "evt-loop-1", type: "change", storyTime: "t1", entityId: "e1", source: "engine", causedBy: "evt-loop-2" }) + "\n"
      + JSON.stringify({ eventId: "evt-loop-2", type: "change", storyTime: "t1", entityId: "e1", source: "engine", causedBy: "evt-loop-1" }) + "\n",
    "utf-8",
  );
  await assert.rejects(
    wg.traceCauses("evt-loop-1"),
    /环/,
    "因果环应抛错而非无限挂起",
  );
}));

test("C4: strict=true 时 invalidated property 与声明实际 property 不匹配抛错，缺省忽略", withTempWg(async (wg) => {
  await wg.birthEntity("e1", "character", { mood: "happy" }, "t1");
  // strict=true：declarationId 存在但 property 填错 → 抛错（防止误闭合）
  await assert.rejects(
    wg.processEvent({
      eventId: "evt-prop-mismatch",
      type: "change",
      storyTime: "t2",
      entityId: "e1",
      invalidated: [{ declarationId: "decl-e1-mood-t1", property: "health" }],
      strict: true,
    }),
    /property 不匹配/,
    "strict 模式下 invalidated property 不匹配应抛错",
  );
  // strict 缺省：property 字段不参与逻辑（历史行为），按 declarationId 正常闭合
  await wg.processEvent({
    eventId: "evt-prop-ignored",
    type: "change",
    storyTime: "t2",
    entityId: "e1",
    invalidated: [{ declarationId: "decl-e1-mood-t1", property: "health" }],
  });
  const snap = await wg.getEntityAt("e1", "t2");
  assert.ok(snap);
  assert.equal(snap!.properties.length, 0, "非 strict 模式下 property 被忽略，声明仍按 declarationId 闭合");
}));
