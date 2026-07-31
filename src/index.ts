// 公共 API 出口（飞书文档"四、模块导出清单"）
// 内部实现文件（world-graph.ts/event-log.ts/character-view.ts）不直接导出
//
// 软隔离约定（2026-07-29）：
// - 无前缀导出 = 公共 API，其他子包与扩展层可直接引用
// - _ 前缀导出 = 包内部实现，不保证稳定，外部不应依赖
//   （包内测试/调试如需访问仍可用，但视为内部契约）

// ============ 公共 API ============

export { WorldGraph } from "./world-graph.js";
export type { EntitySnapshot, MigrateResult } from "./world-graph.js";

// Zod schema 既是值（运行时可调 .parse()）也是类型（编译期类型约束）
// `export { X }` 已同时导出值与其关联类型，无需再 `export type { X }`（否则 TS2300 重复标识符）
export {
  EntityType,
  Modality,
  EventType,
  StateDeclaration,
  EventRecord,
} from "./types.js";
export type { EventRecordInput } from "./types.js";

// ============ 内部导出（_ 前缀，软隔离） ============
// 以下符号当前未被其他子包/扩展层引用，仅本包内部或测试使用。
// 保留导出以便调试，但不保证向后兼容。

export {
  EventSource as _EventSource,
  VisibilityDeclaration as _VisibilityDeclaration,
  INFRA_RELATIONS as _INFRA_RELATIONS,
} from "./types.js";
export type {
  WorldGraphOptions as _WorldGraphOptions,
  TemporalQueryOpts as _TemporalQueryOpts,
} from "./world-graph.js";
