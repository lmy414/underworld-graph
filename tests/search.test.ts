import { test } from "node:test";
import assert from "node:assert/strict";
import { WorldGraph } from "../src/world-graph.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";

async function setupWg() {
  const dir = mkdtempSync(join(tmpdir(), "wg-search-"));
  const wg = await WorldGraph.create({
    dbPath: join(dir, "test.db"),
    eventLogPath: join(dir, "events.jsonl"),
  });
  await wg.birthEntity("macbeth", "character", { name: "Macbeth", title: "Thane of Cawdor" }, "act1-scene1");
  await wg.birthEntity("duncan", "character", { name: "Duncan", title: "King" }, "act1-scene1");
  await wg.birthEntity("inverness", "location", { name: "Inverness", type: "castle" }, "act1-scene1");
  return wg;
}

test("fulltext 检索按 property/description 命中", async () => {
  const wg = await setupWg();
  const hits = await wg.search.fulltext("Fact", { query: "Macbeth", limit: 10 });
  assert.ok(hits.length > 0, "应命中 Macbeth 相关 Fact");
  wg.close();
});

test("fulltext 检索支持中文", async () => {
  const wg = await setupWg();
  await wg.birthEntity("sunwukong", "character", { 名字: "孙悟空", 称号: "齐天大圣" }, "ch1");
  const hits = await wg.search.fulltext("Fact", { query: "孙悟空", limit: 10 });
  assert.ok(hits.length > 0, "应命中孙悟空");
  wg.close();
});

test("0.3.0: description 进全文索引（新库端到端冒烟）", async () => {
  const wg = await setupWg();
  // 中文长句状态内容应可被全文检索命中。
  // 注：FTS5 tokenizer 为 unicode61，连续 CJK 整段为一个 token——整串/前缀查询命中，
  // 短语子串查询不命中（SDK 既定行为，0.2.0 起如此，非本次回归）。
  const text = "对彩叶怀有复杂的感情";
  await wg.birthEntity("e-x", "character", { 心情: text }, "ch1");
  const hits = await wg.search.fulltext("Fact", { query: text, limit: 10 });
  assert.ok(
    hits.some((h: any) => h.node?.entityId === "e-x"),
    "description 内容应可被全文检索命中",
  );
  wg.close();
});

test("0.3.0: birthEntity 非 string 值抛错（description string 契约）", async () => {
  const wg = await setupWg();
  await assert.rejects(
    wg.birthEntity("castle-1", "location", { inventory: { weapon: "sword", gold: 5 } }, "act1-scene1"),
    /必须是 string/,
    "0.3.0 起对象值应抛错（不再序列化 JSON 文本，由消费方负责提供可读文本）",
  );
  wg.close();
});

test("vector 检索需传入 fieldPath + queryEmbedding", async () => {
  const wg = await setupWg();
  // 为 macbeth 实体设置 embedding（向量第一维为 1，其余为 0）
  await wg.reembedAll({
    embedEntity: async (snap) => {
      const vec = new Array(512).fill(0);
      if (snap.entityId === "macbeth") vec[0] = 1;
      return vec;
    },
    embedFact: async () => new Array(512).fill(0),
  });
  // 用相似向量检索，应命中 macbeth
  const queryEmbedding = new Array(512).fill(0);
  queryEmbedding[0] = 1;
  const hits = await wg.search.vector("Entity", {
    fieldPath: "embedding",
    queryEmbedding,
    limit: 10,
  });
  assert.ok(Array.isArray(hits), "vector 检索应返回数组");
  assert.ok(hits.length > 0, "应命中设置了 embedding 的 Entity");
  wg.close();
});

test("hybrid 检索融合 fulltext + vector", async () => {
  const wg = await setupWg();
  // 为 Fact 设置 embedding（property=name 的 Fact 向量第一维为 1）
  await wg.reembedAll({
    embedEntity: async () => new Array(512).fill(0),
    embedFact: async (decl) => {
      const vec = new Array(512).fill(0);
      if (decl.property === "name") vec[0] = 1;
      return vec;
    },
  });
  const queryEmbedding = new Array(512).fill(0);
  queryEmbedding[0] = 1;
  const hits = await wg.search.hybrid("Fact", {
    vector: { fieldPath: "embedding", queryEmbedding },
    fulltext: { query: "Macbeth" },
    limit: 10,
  });
  assert.ok(Array.isArray(hits), "hybrid 检索应返回数组");
  assert.ok(hits.length > 0, "hybrid 应融合命中结果");
  wg.close();
});
