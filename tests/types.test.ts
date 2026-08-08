import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EntityType,
  Modality,
  EventType,
  StateDeclaration,
  EventRecord,
  VisibilityDeclaration,
  INFRA_RELATIONS,
} from "../src/types.js";

test("EntityType 接受 4 类几何定义", () => {
  assert.equal(EntityType.parse("character"), "character");
  assert.equal(EntityType.parse("location"), "location");
  assert.equal(EntityType.parse("item"), "item");
  assert.equal(EntityType.parse("concept"), "concept");
});

test("EntityType 拒绝旧 NodeType 值", () => {
  assert.throws(() => EntityType.parse("character-item"));
  assert.throws(() => EntityType.parse("scene-prop"));
  assert.throws(() => EntityType.parse("background"));
});

test("Modality 接受 3 类模态", () => {
  assert.equal(Modality.parse("fact"), "fact");
  assert.equal(Modality.parse("belief"), "belief");
  assert.equal(Modality.parse("hypothesis"), "hypothesis");
});

test("EventType 接受 3 类事件", () => {
  assert.equal(EventType.parse("birth"), "birth");
  assert.equal(EventType.parse("death"), "death");
  assert.equal(EventType.parse("change"), "change");
});

test("StateDeclaration 校验完整字段", () => {
  const decl = StateDeclaration.parse({
    declarationId: "decl-1",
    entityId: "ent-macbeth",
    property: "title",
    description: "Thane of Cawdor",
    modality: "fact",
    validFrom: "act1-scene1",
    validTo: "Infinity",
  });
  assert.equal(decl.validTo, "Infinity");
});

test("StateDeclaration 拒绝 Date 对象作为 validFrom", () => {
  assert.throws(() => StateDeclaration.parse({
    declarationId: "decl-1",
    entityId: "ent-macbeth",
    property: "title",
    description: "Thane",
    modality: "fact",
    validFrom: new Date(),
    validTo: "Infinity",
  }));
});

test("EventRecord 校验 change 事件", () => {
  const evt = EventRecord.parse({
    eventId: "evt-001",
    type: "change",
    storyTime: "act2-scene2",
    entityId: "ent-duncan",
    invalidated: [{ declarationId: "decl-old", property: "status" }],
    newFacts: [{ entityId: "ent-duncan", property: "status", description: "dead", modality: "fact" }],
    causedBy: "evt-ladym-persuade",
  });
  assert.equal(evt.causedBy, "evt-ladym-persuade");
});

test("EventRecord birth 事件可省略 invalidated/newFacts", () => {
  const evt = EventRecord.parse({
    eventId: "evt-birth-1",
    type: "birth",
    storyTime: "act1-scene1",
    entityId: "ent-macbeth",
  });
  assert.equal(evt.invalidated, undefined);
});

test("0.3.0: EventRecord.newFacts 缺失 description 拒绝解析（不兼容旧 value 行）", () => {
  const result = EventRecord.safeParse({
    eventId: "evt-old-1",
    type: "change",
    storyTime: "act2-scene2",
    entityId: "ent-duncan",
    newFacts: [{ entityId: "ent-duncan", property: "status", value: "dead", modality: "fact" }],
  });
  assert.ok(!result.success, "0.3.0 起 newFacts 必须携带 description，旧 value 键被拒（决策：不兼容旧数据）");
});

test("0.3.0: StateDeclaration 缺失 description 拒绝解析，旧 value 键被剥离", () => {
  const noDesc = StateDeclaration.safeParse({
    declarationId: "decl-1",
    entityId: "e1",
    property: "名字",
    modality: "fact",
    validFrom: "t1",
    validTo: "Infinity",
  });
  assert.ok(!noDesc.success, "description 为必填字段");
  const withOldValue = StateDeclaration.safeParse({
    declarationId: "decl-1",
    entityId: "e1",
    property: "名字",
    value: "旧值",
    modality: "fact",
    validFrom: "t1",
    validTo: "Infinity",
  });
  assert.ok(!withOldValue.success, "旧 value 键不能替代 description");
});

test("VisibilityDeclaration 校验完整字段", () => {
  const vis = VisibilityDeclaration.parse({
    characterId: "ent-macbeth",
    declarationId: "decl-1",
    state: "known",
    confidence: 0.5,
    source: "informed",
    validFrom: "act2-scene1",
    validTo: "Infinity",
    isExplicit: true,
  });
  assert.equal(vis.isExplicit, true);
});

test("INFRA_RELATIONS 至少含 located_in", () => {
  assert.ok(INFRA_RELATIONS.includes("located_in"));
});
