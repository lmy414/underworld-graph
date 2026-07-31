import { test } from "node:test";
import assert from "node:assert/strict";

test("StateDeclaration schema 包含 valueText 字段", async () => {
  const { StateDeclaration } = await import("../src/types.js");
  const parsed = StateDeclaration.safeParse({
    declarationId: "decl-1",
    entityId: "e1",
    property: "name",
    value: "Macbeth",
    valueText: "Macbeth",
    modality: "fact",
    validFrom: "act1-scene1",
    validTo: "Infinity",
  });
  assert.ok(parsed.success, "valueText 应可解析");
  assert.equal(parsed.data?.valueText, "Macbeth");
});

test("StateDeclaration schema valueText 可选", async () => {
  const { StateDeclaration } = await import("../src/types.js");
  const parsed = StateDeclaration.safeParse({
    declarationId: "decl-1",
    entityId: "e1",
    property: "name",
    value: "Macbeth",
    modality: "fact",
    validFrom: "act1-scene1",
    validTo: "Infinity",
  });
  assert.ok(parsed.success, "valueText 省略时应可解析");
  assert.equal(parsed.data?.valueText, undefined);
});
