// 端到端冒烟：Macbeth 故事片段（飞书文档"步骤 8"示例）
import { WorldGraph } from "../src/index.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), "wg-smoke-"));
const wg = await WorldGraph.create({
  dbPath: join(dir, "world.db"),
  eventLogPath: join(dir, "events.jsonl"),
});

try {
  console.log("1. birthEntity macbeth + inverness");
  await wg.birthEntity("ent-macbeth", "character", { title: "Thane of Glamis" }, "act1-scene1");
  await wg.birthEntity("ent-inverness", "location", { temp: "cold" }, "act1-scene1");

  console.log("2. addRelation located_in");
  await wg.addRelation("ent-macbeth", "ent-inverness", "located_in", "act1-scene1");

  console.log("3. processEvent change (Duncan 访问 Inverness)");
  await wg.processEvent({
    eventId: "evt-duncan-visit",
    type: "change",
    storyTime: "act1-scene4",
    entityId: "ent-inverness",
    invalidated: [],
    newFacts: [{ entityId: "ent-inverness", property: "visitor", value: "Duncan", modality: "fact" }],
    causedBy: undefined,
  });

  console.log("4. inferVisibility");
  await wg.inferVisibility("act1-scene4");

  console.log("5. getCharacterView (Macbeth 视角)");
  const view = await wg.getCharacterView("ent-macbeth", "act1-scene4", { modalityFilter: ["fact"] });
  console.log("  可见声明数:", view.length);
  const visitor = view.find((d) => d.property === "visitor");
  if (!visitor) throw new Error("Macbeth 应看到 visitor 声明");
  console.log("  visitor:", visitor.value);

  console.log("6. traceCauses");
  const chain = await wg.traceCauses("evt-duncan-visit");
  console.log("  因果链长度:", chain.length);

  console.log("7. killEntity + 验证消亡后查不到");
  await wg.killEntity("ent-duncan", "act2-scene2").catch(() => {});
  // Duncan 不存在，跳过；改为 killEntity inverness
  await wg.killEntity("ent-inverness", "act5-scene1");
  const after = await wg.getEntityAt("ent-inverness", "act5-scene1");
  if (after !== null) throw new Error("Inverness 消亡后应返回 null");

  console.log("\n✅ 端到端冒烟全部通过");
} catch (err) {
  console.error("\n❌ 冒烟失败:", err.message);
  process.exit(1);
} finally {
  wg.close();
  rmSync(dir, { recursive: true, force: true });
}
