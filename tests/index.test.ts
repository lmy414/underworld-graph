import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WorldGraph,
  EntityType,
  Modality,
  EventType,
  _INFRA_RELATIONS,
  _VisibilityDeclaration,
} from "../src/index.js";
import type { EventRecordInput, StateDeclaration } from "../src/index.js";

test("WorldGraph 类可导入", () => {
  assert.equal(typeof WorldGraph, "function");
});

test("EntityType/Modality/EventType 枚举可导入", () => {
  assert.equal(EntityType.parse("character"), "character");
  assert.equal(Modality.parse("fact"), "fact");
  assert.equal(EventType.parse("birth"), "birth");
});

test("INFRA_RELATIONS 常量可导入且含 located_in（内部导出 _ 前缀）", () => {
  assert.ok(Array.isArray(_INFRA_RELATIONS));
  assert.ok(_INFRA_RELATIONS.includes("located_in"));
});

test("类型可导入（编译期检查）", () => {
  const evt: EventRecordInput = {
    eventId: "e1", type: "birth", storyTime: "t1", entityId: "x1",
  };
  const decl: StateDeclaration = {
    declarationId: "d1", entityId: "x1", property: "p", value: "v",
    modality: "fact", validFrom: "t1", validTo: "Infinity",
  };
  const vis: _VisibilityDeclaration = {
    characterId: "c1", declarationId: "d1", state: "known",
    confidence: 1, source: "experienced", validFrom: "t1", validTo: "Infinity", isExplicit: true,
  };
  assert.ok(evt);
  assert.ok(decl);
  assert.ok(vis);
});
