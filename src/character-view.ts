import type { WorldGraph } from "./world-graph.js";
import type { VisibilityDeclaration, StateDeclaration, Modality } from "./types.js";

const INFINITY = "Infinity";

/**
 * character_view 五步过滤（飞书文档"步骤 5"，2026-07-22 语义修订：知识持续）
 * 1. 查询全部 StateDeclaration（含已闭合——知识不因声明闭合/实体死亡而消失）
 * 2. 查询 characterId 在 storyTime 时刻持有的 VisibilityDeclaration
 *    （可见性需覆盖 storyTime：validFrom <= storyTime < validTo，由查询保证）
 * 3. 有效起点 = max(visibility.validFrom, declaration.validFrom)（不能先于声明存在而知晓）
 * 4. 有效终点 = visibility.validTo（不再与 declaration.validTo 取交：
 *    知识一旦获得就持续持有，直到可见性被显式撤销）
 * 5. 过滤 state === "known" && start <= storyTime && modalityFilter 命中
 *
 * 注意：validTo = "Infinity" 表示未闭合，字符串比较 'I' < 'a' 会导致误判，
 * 故覆盖判断需特殊处理 Infinity（由 getVisibilityForCharacter 处理）。
 */
export async function characterView(
  wg: WorldGraph,
  characterId: string,
  storyTime: string,
  opts: { modalityFilter?: Modality[]; recordedAsOf?: string } = {},
): Promise<StateDeclaration[]> {
  // recordedAsOf（事务时间轴）：声明与可见性记录都重建到该写入时点，
  // 之后补写/改写的内容不可见（retcon 隔离）
  const allDecls = await wg.getAllDeclarations({ recordedAsOf: opts.recordedAsOf });
  const visDecls = await wg.getVisibilityForCharacter(characterId, storyTime, {
    recordedAsOf: opts.recordedAsOf,
  });
  const modalityFilter = opts.modalityFilter;

  const visible: StateDeclaration[] = [];
  for (const decl of allDecls) {
    const vis = visDecls.find((v) => v.declarationId === decl.declarationId);
    if (!vis) continue;
    if (vis.state !== "known") continue;
    const start = vis.validFrom > decl.validFrom ? vis.validFrom : decl.validFrom;
    if (!(start <= storyTime)) continue;
    if (modalityFilter && !modalityFilter.includes(decl.modality)) continue;
    visible.push(decl);
  }
  return visible;
}

/**
 * 基础设施关系推断（飞书文档"步骤 6"）
 * 遍历 storyTime 时刻所有 located_in 关系
 * 对每条关系，把 target 实体的所有有效声明标记为 source 角色可见
 * validFrom 取角色进入时间和声明时间中较晚者
 */
export async function inferVisibility(wg: WorldGraph, storyTime: string): Promise<void> {
  const allRels = await wg.getAllRelationsAt(storyTime);
  const locatedIn = allRels.filter((r) => r.label === "located_in");
  for (const rel of locatedIn) {
    const targetDecls = await wg.getEntityAt(rel.targetId, storyTime);
    if (!targetDecls) continue;
    for (const decl of targetDecls.properties) {
      const validFrom = rel.validFrom > decl.validFrom ? rel.validFrom : decl.validFrom;
      if (validFrom > storyTime) continue;
      await wg.setVisibility(rel.sourceId, decl.declarationId, {
        state: "known",
        confidence: 1,
        source: "witnessed",
        validFrom,
        isExplicit: false,
      });
    }
  }
}
