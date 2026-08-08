import { test } from "node:test";
import assert from "node:assert/strict";

test("0.3.0: StateDeclaration schema 含 description 字段（必填）", async () => {
  const { StateDeclaration } = await import("../src/types.js");
  const parsed = StateDeclaration.safeParse({
    declarationId: "decl-1",
    entityId: "e1",
    property: "名字",
    description: "Macbeth",
    modality: "fact",
    validFrom: "act1-scene1",
    validTo: "Infinity",
  });
  assert.ok(parsed.success, "description 应可解析");
  assert.equal(parsed.data?.description, "Macbeth");
});

test("0.3.0: StateDeclaration schema 缺失 description 解析失败（必填字段）", async () => {
  const { StateDeclaration } = await import("../src/types.js");
  const parsed = StateDeclaration.safeParse({
    declarationId: "decl-1",
    entityId: "e1",
    property: "名字",
    modality: "fact",
    validFrom: "act1-scene1",
    validTo: "Infinity",
  });
  assert.ok(!parsed.success, "description 缺失时应解析失败");
});

test("0.3.0: StateDeclaration schema 不含 value/valueText 字段（输出形状 E1 统一）", async () => {
  const { StateDeclaration } = await import("../src/types.js");
  const parsed = StateDeclaration.safeParse({
    declarationId: "decl-1",
    entityId: "e1",
    property: "名字",
    description: "Macbeth",
    modality: "fact",
    validFrom: "act1-scene1",
    validTo: "Infinity",
  });
  assert.ok(parsed.success);
  assert.ok(!("value" in parsed.data!), "输出不应含 value 键（旧 value 键被剥离）");
  assert.ok(!("valueText" in parsed.data!), "输出不应含 valueText 键");
});
