import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorldGraph } from "../src/world-graph.js";

function withTempWg(fn: (wg: WorldGraph, dir: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "wg-vis-"));
    const wg = await WorldGraph.create({
      dbPath: join(dir, "world.db"),
      eventLogPath: join(dir, "events.jsonl"),
    });
    try { await fn(wg, dir); } finally { wg.close(); rmSync(dir, { recursive: true, force: true }); }
  };
}

test("setVisibility 显式声明角色知道某声明", withTempWg(async (wg) => {
  await wg.birthEntity("ent-macbeth", "character", { title: "Thane" }, "act1-scene1");
  const snap = await wg.getEntityAt("ent-macbeth", "act1-scene1");
  const titleDecl = snap!.properties.find((d: any) => d.property === "title")!;
  await wg.setVisibility("ent-macbeth", titleDecl.declarationId, {
    state: "known",
    confidence: 1,
    source: "experienced",
    validFrom: "act1-scene1",
    isExplicit: true,
  });
}));

test("inferVisibility 从 located_in 自动推断", withTempWg(async (wg) => {
  await wg.birthEntity("ent-macbeth", "character", {}, "act1-scene1");
  await wg.birthEntity("ent-inverness", "location", { visitor: "Duncan" }, "act1-scene1");
  await wg.addRelation("ent-macbeth", "ent-inverness", "located_in", "act1-scene1");
  await wg.processEvent({
    eventId: "evt-visit",
    type: "change",
    storyTime: "act1-scene4",
    entityId: "ent-inverness",
    newFacts: [{ entityId: "ent-inverness", property: "visitor", value: "Duncan", modality: "fact" }],
  });
  await wg.inferVisibility("act1-scene4");
}));
