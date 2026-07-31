import { z } from "zod";

/**
 * 实体类型 — 4 类几何定义（飞书文档"三、实体类型"）
 * - character: 有意志的实体（角色）
 * - location: 被动空间实体（场景）
 * - item: 物品实体
 * - concept: 弥漫性概念实体（世界观、规则、组织）
 */
export const EntityType = z.enum(["character", "location", "item", "concept"]);
export type EntityType = z.infer<typeof EntityType>;

/**
 * 模态系统 — 声明的认识论地位（飞书文档"五、模态系统"）
 * - fact: 客观事实
 * - belief: 角色信念（主观）
 * - hypothesis: 假设/推测
 */
export const Modality = z.enum(["fact", "belief", "hypothesis"]);
export type Modality = z.infer<typeof Modality>;

/**
 * 事件类型 — 3 类原子操作（飞书文档"6.1 事件的结构"）
 * - birth: 实体诞生
 * - death: 实体消亡
 * - change: 状态/关系变更
 */
export const EventType = z.enum(["birth", "death", "change"]);
export type EventType = z.infer<typeof EventType>;

/**
 * 状态声明 — TypeGraph 中状态的最小单元（飞书文档"步骤 1"）
 * 每条声明独立持有 validFrom/validTo 时态区间
 * validTo = "Infinity" 表示未闭合
 */
export const StateDeclaration = z.object({
  declarationId: z.string(),
  entityId: z.string(),
  property: z.string(),
  value: z.unknown(),
  valueText: z.string().optional(),
  modality: Modality,
  validFrom: z.string(),  // ISO 8601 字符串或故事时间标识
  validTo: z.string(),    // "Infinity" = 未闭合
});
export type StateDeclaration = z.infer<typeof StateDeclaration>;

/**
 * 事件记录 — JSONL 事件日志的条目（飞书文档"2.4 事件处理"）
 * type=change 时用 invalidated/newFacts
 * type=birth/death 时可省略 invalidated/newFacts
 * causedBy 指向因果链前驱事件
 * source 区分事件来源：engine=引擎扩散产生，user=用户/前端编辑产生
 */
export const EventSource = z.enum(["engine", "user"]);
export type EventSource = z.infer<typeof EventSource>;

export const EventRecord = z.object({
  eventId: z.string(),
  type: EventType,
  storyTime: z.string(),
  entityId: z.string(),
  source: EventSource.default("engine"),
  entityType: EntityType.optional(),  // birth 事件用：指定实体类型，默认 character
  summary: z.string().optional(),     // birth 事件用：实体无状态客观事实描述（独立数据字段）
  invalidated: z.array(z.object({
    declarationId: z.string(),
    property: z.string(),
  })).optional(),
  newFacts: z.array(z.object({
    entityId: z.string(),
    property: z.string(),
    value: z.unknown(),
    modality: Modality,
  })).optional(),
  causedBy: z.string().optional(),
  /**
   * 用户口述原文（2026-07-25 新增，跨会话项目记忆）
   * 主会话把用户的自然语言原话透传到 scheduler_dispatch(userInput)，
   * commit 写扩散时落到每个 change 事件；引擎自动维护的项目记忆文件
   * （memory.md）展示最近事件时引用此字段。
   */
  userInput: z.string().optional(),
  /**
   * 写入墙钟时间（2026-07-25 新增，双时态检索的事务时间轴）
   * processEvent 自动填充（new Date().toISOString()），调用方可显式覆盖。
   * 旧事件日志行无此字段，故为可选。
   */
  recordedAt: z.string().optional(),
});
export type EventRecord = z.infer<typeof EventRecord>;
/** 调用方传入的事件（source 可省略，parse 时默认 "engine"） */
export type EventRecordInput = z.input<typeof EventRecord>;

/**
 * 可见性来源 — 区分角色是如何知道某条声明的
 * - experienced: 自产自知（角色自己产出的 state_change，commit 4.3 步写入，confidence=1）
 * - informed: 他盲修复（角色通过对话/观察学到的他人状态，commit 4.4 步 knowledgeMapper 映射后写入）
 * - witnessed: 基础设施推断（inferVisibility 自动为 located_in 关系推导的同地点互相可见）
 *
 * 2026-07-29：从 z.string() 改为枚举，清理历史遗留值 self/rumor/told/explicit/inferred。
 * 旧数据保持原样不迁移（用户决策），仅新写入受枚举约束。
 */
export const VisibilitySource = z.enum(["experienced", "informed", "witnessed"]);
export type VisibilitySource = z.infer<typeof VisibilitySource>;

/**
 * 可见性声明 — character_view 的基础单元（飞书文档"2.6 可见性管理"+"步骤 5"）
 */
export const VisibilityDeclaration = z.object({
  characterId: z.string(),
  declarationId: z.string(),
  state: z.enum(["known"]),
  confidence: z.number().min(0).max(1),
  source: VisibilitySource,
  validFrom: z.string(),
  validTo: z.string().default("Infinity"),
  isExplicit: z.boolean(),
});
export type VisibilityDeclaration = z.infer<typeof VisibilityDeclaration>;

/**
 * 基础设施关系常量 — [存疑-2] 飞书文档"四、模块导出清单"提到但未列举
 * 推测至少含 located_in（步骤6 用到）
 * Task 9 实施前需 fetch 飞书文档"四、关系类型"section 核对
 */
export const INFRA_RELATIONS: readonly string[] = ["located_in"] as const;
