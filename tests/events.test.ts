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
  assert.equal(chain.length, 1, "失败事件仍留在 JSONL（因果链审计语义）");
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
  assert.equal(chain.length, 1);
  assert.equal(chain[0].eventId, "evt-log-1");
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
