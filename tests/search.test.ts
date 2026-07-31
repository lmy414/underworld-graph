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

test("fulltext 检索按 property/valueText 命中", async () => {
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
