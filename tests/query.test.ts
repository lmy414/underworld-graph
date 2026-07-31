import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorldGraph } from "../src/world-graph.js";

function withTempWg(fn: (wg: WorldGraph) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "wg-q-"));
    const wg = await WorldGraph.create({ dbPath: join(dir, "world.db"), eventLogPath: join(dir, "events.jsonl") });
    try { await fn(wg); } finally { wg.close(); rmSync(dir, { recursive: true, force: true }); }
  };
}

test("getAllEntities 返回所有有效实体", withTempWg(async (wg) => {
  await wg.birthEntity("e1", "character", {}, "t1");
  await wg.birthEntity("e2", "location", {}, "t1");
  await wg.killEntity("e1", "t2");
  const all = await wg.getAllEntities("t1");
  assert.equal(all.length, 2);
  const after = await wg.getAllEntities("t2");
  assert.equal(after.length, 1);
  assert.equal(after[0].entityId, "e2");
}));

test("traceCauses 多级回溯", withTempWg(async (wg) => {
  await wg.processEvent({ eventId: "evt-a", type: "birth", storyTime: "t1", entityId: "e1" });
  await wg.processEvent({
    eventId: "evt-b", type: "change", storyTime: "t2", entityId: "e1",
    invalidated: [], newFacts: [{ entityId: "e1", property: "p", value: "v1", modality: "fact" }],
    causedBy: "evt-a",
  });
  await wg.processEvent({
    eventId: "evt-c", type: "change", storyTime: "t3", entityId: "e1",
    invalidated: [], newFacts: [{ entityId: "e1", property: "p", value: "v2", modality: "fact" }],
    causedBy: "evt-b",
  });
  const chain = await wg.traceCauses("evt-c");
  assert.deepEqual(chain.map((e: any) => e.eventId), ["evt-a", "evt-b", "evt-c"]);
}));
