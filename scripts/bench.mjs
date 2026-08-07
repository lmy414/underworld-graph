// B5 台账修复（2026-08-07）配套基准：全表扫描热点修复后的耗时量级。
//
// 造 N 个实体 + 每实体 5 条 Fact 的临时库，基准：
// - getAllEntities（N+1 已消除：Entity/Fact 各取一次内存分组）
// - killEntity（where 谓词下推替代 find() 全表扫描）
// - getCharacterView（可见性查询下推后的端到端视角查询）
//
// 用法：node scripts/bench.mjs  （N 默认 1000，可用环境变量 BENCH_N 覆盖）
// 修复前对比：git stash 后跑同一脚本即可得到旧实现数字。
import { WorldGraph } from "../dist/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";

const N = Number(process.env.BENCH_N ?? 1000);
const FACTS_PER_ENTITY = 5;

const dir = mkdtempSync(join(tmpdir(), "wg-bench-"));
const wg = await WorldGraph.create({
  dbPath: join(dir, "world.db"),
  eventLogPath: join(dir, "events.jsonl"),
});

function fmt(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms.toFixed(1)}ms`;
}

try {
  console.log(`造数：${N} 实体 × ${FACTS_PER_ENTITY} Fact ...`);
  const t0 = performance.now();
  for (let i = 0; i < N; i++) {
    const props = {};
    for (let j = 0; j < FACTS_PER_ENTITY; j++) {
      props[`prop${j}`] = `value-${i}-${j}`;
    }
    await wg.birthEntity(`ent-${i}`, "character", props, "ch001.ev001");
    if ((i + 1) % 200 === 0) console.log(`  ${i + 1}/${N}`);
  }
  console.log(`造数完成，耗时 ${fmt(performance.now() - t0)}`);

  // getAllEntities：旧实现 O(N²)（每实体一次 getEntityAt 全扫两表），新实现两表各取一次
  let t = performance.now();
  const all = await wg.getAllEntities("ch001.ev001");
  console.log(`getAllEntities(${all.length} 实体): ${fmt(performance.now() - t)}`);

  // killEntity：旧实现 Entity/Fact 各全扫一次
  t = performance.now();
  await wg.killEntity(`ent-${N - 1}`, "ch002.ev001");
  console.log(`killEntity(末位实体): ${fmt(performance.now() - t)}`);

  // getCharacterView：给少量声明配可见性后查询视角
  await wg.setVisibility("ent-0", "decl-ent-1-prop0-ch001.ev001", {
    state: "known", confidence: 1, source: "informed", validFrom: "ch001.ev001", isExplicit: true,
  });
  t = performance.now();
  const view = await wg.getCharacterView("ent-0", "ch001.ev001");
  console.log(`getCharacterView(可见 ${view.length} 条): ${fmt(performance.now() - t)}`);

  console.log("\n✅ bench 完成");
} finally {
  wg.close();
  rmSync(dir, { recursive: true, force: true });
}
