import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { load as loadSqliteVec } from "sqlite-vec";
import {
  createStoreWithSchema,
  defineNode,
  defineEdge,
  defineGraph,
  searchable,
  embedding,
  sqliteVecStrategy,
} from "@nicia-ai/typegraph";
import type { HistoryStore, EmbeddingValue, RecordedInstant } from "@nicia-ai/typegraph";
import {
  createSqliteBackend,
  generateSqliteMigrationSQL,
} from "@nicia-ai/typegraph/adapters/drizzle/sqlite";
import { getActiveSchema, migrateSchema } from "@nicia-ai/typegraph/schema";
import { z } from "zod";
import { EntityType, Modality, EventRecord, VisibilitySource } from "./types.js";
import type { StateDeclaration, VisibilityDeclaration, EventRecordInput } from "./types.js";
import { EventLog } from "./event-log.js";

const INFINITY = "Infinity";

/**
 * TypeGraph 节点定义 — Entity（实体）与 Fact（状态声明）
 * validFrom/validTo 作为 schema 字段，由应用层管理 bi-temporal 语义
 * "Infinity" 表示未闭合
 */
const EntityNode = defineNode("Entity", {
  schema: z.object({
    entityId: z.string(),
    type: EntityType,
    summary: z.string().default(""),  // 实体无状态客观事实描述，独立数据字段，参与向量检索，注入角色扮演上下文
    validFrom: z.string(),
    validTo: z.string(),
    embedding: embedding(512).optional(),
  }),
});

const FactNode = defineNode("Fact", {
  schema: z.object({
    declarationId: z.string(),
    entityId: z.string(),
    property: searchable({ language: "zh" }),
    value: z.unknown(),
    valueText: searchable({ language: "zh" }).optional(),
    embedding: embedding(512).optional(),
    modality: Modality,
    validFrom: z.string(),
    validTo: z.string(),
  }),
});

const RelationNode = defineNode("Relation", {
  schema: z.object({
    relationId: z.string(),
    sourceId: z.string(),
    targetId: z.string(),
    label: z.string(),
    validFrom: z.string(),
    validTo: z.string(),
  }),
});

const VisibilityNode = defineNode("Visibility", {
  schema: z.object({
    visibilityId: z.string(),
    characterId: z.string(),
    declarationId: z.string(),
    state: z.enum(["known"]),
    confidence: z.number(),
    source: VisibilitySource,
    validFrom: z.string(),
    validTo: z.string(),
    isExplicit: z.boolean(),
  }),
});

const declaresEdge = defineEdge("declares");

const graph = defineGraph({
  id: "world",
  nodes: {
    Entity: { type: EntityNode },
    Fact: { type: FactNode },
    Relation: { type: RelationNode },
    Visibility: { type: VisibilityNode },
  },
  edges: {
    declares: { type: declaresEdge, from: [EntityNode], to: [FactNode] },
  },
});

export interface WorldGraphOptions {
  dbPath: string;
  eventLogPath: string;
}

/** WorldGraph.migrate 返回的迁移结果 */
export interface MigrateResult {
  /** 迁移前激活的 schema 版本 */
  fromVersion: number;
  /** 迁移后的 schema 版本 */
  toVersion: number;
}

export interface EntitySnapshot {
  entityId: string;
  type: EntityType;
  summary: string;
  validFrom: string;
  validTo: string;
  properties: StateDeclaration[];
}

/**
 * 双时态查询选项（2026-07-25 新增）
 *
 * recordedAsOf：事务时间坐标（SDK recorded instant，由 recordedNow() 获取，
 * 形如 "r1:0000000000000007:2026-07-25T16:02:32.048Z"，字典序可比较）。
 *
 * 语义：「storyTime 时刻的世界状态，但只含 recordedAsOf 之前写入的内容」。
 * 用途：modify/insert 锚定历史事件时，角色视角/查询不被后来补写的
 * 设定污染（retcon 隔离）；不带 recordedAsOf 的调用行为完全不变。
 */
export interface TemporalQueryOpts {
  recordedAsOf?: string;
}

export class WorldGraph {
  private db: Database.Database;
  private store: HistoryStore<typeof graph>;
  private eventLog: EventLog;

  private constructor(
    db: Database.Database,
    store: HistoryStore<typeof graph>,
    eventLog: EventLog,
  ) {
    this.db = db;
    this.store = store;
    this.eventLog = eventLog;
  }

  /**
   * 异步工厂：通过 createStoreWithSchema 初始化 fulltext/vector storage。
   * searchable/embedding 字段要求 store 在创建时已完成 schema 初始化，
   * 否则 node.create 会触发 STORE_NOT_INITIALIZED。
   *
   * sqlite-vec 扩展在 Database 创建后立即加载，使 createSqliteBackend
   * 的 vector strategy 可用（向量 DDL/写入/检索）。
   * createStoreWithSchema 默认 systemIndexes:"materialize"，自动调用
   * materializeSystemIndexesOnBoot，无需手动 materializeIndexes/rebuildFulltext。
   */
  static async create(opts: WorldGraphOptions): Promise<WorldGraph> {
    const db = new Database(opts.dbPath);
    try {
      db.pragma("journal_mode = WAL");
      loadSqliteVec(db);
      const drizzleDb = drizzle(db);
      db.exec(generateSqliteMigrationSQL());
      const backend = createSqliteBackend(drizzleDb, { vector: sqliteVecStrategy });
      const [store, _schemaResult] = await createStoreWithSchema(graph, backend, { history: true });
      const eventLog = new EventLog(opts.eventLogPath);
      return new WorldGraph(db, store, eventLog);
    } catch (err) {
      // schema 校验失败（如 MIGRATION_ERROR）时释放句柄，避免占用 db 文件
      db.close();
      throw err;
    }
  }

  /**
   * 执行 schema 迁移（typegraph migrateSchema）
   *
   * 适用场景：旧版引擎创建的 world.db 在新版代码下 create 会抛
   * MIGRATION_ERROR（schema 定义有变更）。本方法用当前 graph 定义提交
   * 新 schema 版本，完成后 create 即可正常打开。
   *
   * 安全：调用方（ProjectRegistry.migrateProject）负责在调用前备份 db 文件。
   *
   * @returns 迁移前后的 schema 版本号
   */
  static async migrate(opts: WorldGraphOptions): Promise<MigrateResult> {
    const db = new Database(opts.dbPath);
    try {
      db.pragma("journal_mode = WAL");
      loadSqliteVec(db);
      const drizzleDb = drizzle(db);
      db.exec(generateSqliteMigrationSQL());
      const backend = createSqliteBackend(drizzleDb, { vector: sqliteVecStrategy });
      const active = await getActiveSchema(backend, graph.id);
      if (!active) {
        throw new Error("schema 未初始化，无需迁移（空库请直接 create）");
      }
      const toVersion = await migrateSchema(backend, graph, active.version);
      return { fromVersion: active.version, toVersion };
    } finally {
      db.close();
    }
  }

  close(): void {
    this.db.close();
  }

  /**
   * 暴露 SDK 全文/向量/混合检索能力。
   * 透传 store.search（StoreSearch<typeof graph>），调用方可用 fulltext/vector/hybrid。
   */
  get search() {
    return this.store.search;
  }

  /**
   * 暴露 SDK QueryBuilder 入口，供复杂图遍历查询使用。
   */
  query() {
    return this.store.query();
  }

  /**
   * 当前事务时间坐标（SDK recorded instant）。
   * 调用方可存档该值，后续作为 recordedAsOf 传入查询实现双时态检索。
   * 空图（尚无写入）返回 undefined。
   */
  async recordedNow(): Promise<string | undefined> {
    const instant = await this.store.recordedNow();
    return instant as string | undefined;
  }

  /**
   * 双时态节点读取：带 recordedAsOf 时走 SDK RecordedStoreView 重建
   * 该事务时点的节点状态（含后续被闭合/修改的字段原值）；否则走 live find()。
   * scan 单页上限 1000，循环翻页取全量（与 find() 语义对齐）。
   */
  private async findNodes(
    kind: "Entity" | "Fact" | "Relation" | "Visibility",
    recordedAsOf?: string,
  ): Promise<any[]> {
    if (!recordedAsOf) {
      return await (this.store.nodes as any)[kind].find();
    }
    const view = this.store.asOfRecorded(recordedAsOf as RecordedInstant);
    const collection = (view.nodes as any)[kind];
    const out: any[] = [];
    let after: string | undefined;
    do {
      const page = await collection.scan({ limit: 1000, after });
      out.push(...page.data);
      after = page.nextCursor;
    } while (after);
    return out;
  }

  async birthEntity(
    entityId: string,
    entityType: EntityType,
    initialProps: Record<string, unknown>,
    storyTime: string,
    summary?: string,
  ): Promise<void> {
    await this.store.nodes.Entity.create({
      entityId,
      type: entityType,
      summary: summary ?? "",
      validFrom: storyTime,
      validTo: INFINITY,
    });
    for (const [prop, val] of Object.entries(initialProps)) {
      const declarationId = `decl-${entityId}-${prop}-${storyTime}`;
      await this.store.nodes.Fact.create({
        declarationId,
        entityId,
        property: prop,
        value: val,
        valueText: String(val),
        modality: "fact",
        validFrom: storyTime,
        validTo: INFINITY,
      });
    }
  }

  async killEntity(entityId: string, storyTime: string): Promise<void> {
    const entities = await this.store.nodes.Entity.find();
    const ent = entities.find(
      (e: any) => e.entityId === entityId && e.validTo === INFINITY,
    );
    if (!ent) throw new Error(`Entity ${entityId} not found or already dead`);
    await this.store.nodes.Entity.update(ent.id, { validTo: storyTime });
    // 级联关闭该实体所有未闭合 Fact
    const facts = await this.store.nodes.Fact.find();
    for (const f of facts) {
      if (f.entityId === entityId && f.validTo === INFINITY) {
        await this.store.nodes.Fact.update(f.id, { validTo: storyTime });
      }
    }
  }

  async getEntityAt(
    entityId: string,
    storyTime: string,
    opts?: TemporalQueryOpts,
  ): Promise<EntitySnapshot | null> {
    // bi-temporal 查询：validFrom <= storyTime < validTo（故事时间轴）
    // 叠加 opts.recordedAsOf（事务时间轴）：只含该时点之前写入的内容
    // "Infinity" 需特殊处理（字符串比较 'I' < 'a' 导致误判）
    const entities = await this.findNodes("Entity", opts?.recordedAsOf);
    const ent = entities.find(
      (e: any) =>
        e.entityId === entityId &&
        e.validFrom <= storyTime &&
        (e.validTo === INFINITY || storyTime < e.validTo),
    );
    if (!ent) return null;
    const facts = await this.findNodes("Fact", opts?.recordedAsOf);
    const props = facts
      .filter(
        (f: any) =>
          f.entityId === entityId &&
          f.validFrom <= storyTime &&
          (f.validTo === INFINITY || storyTime < f.validTo),
      )
      .map(
        (f: any) =>
          ({
            declarationId: f.declarationId,
            entityId: f.entityId,
            property: f.property,
            value: f.value,
            modality: f.modality,
            validFrom: f.validFrom,
            validTo: f.validTo,
          }) as StateDeclaration,
      );
    return {
      entityId,
      type: ent.type,
      summary: ent.summary ?? "",
      validFrom: ent.validFrom,
      validTo: ent.validTo,
      properties: props,
    };
  }

  async addRelation(
    sourceId: string,
    targetId: string,
    label: string,
    storyTime: string,
  ): Promise<void> {
    const relationId = `rel-${sourceId}-${label}-${targetId}-${storyTime}`;
    await this.store.nodes.Relation.create({
      relationId,
      sourceId,
      targetId,
      label,
      validFrom: storyTime,
      validTo: INFINITY,
    });
  }

  /**
   * 更新实体摘要（作者可见的元信息，纯展示字段）。
   * 不参与时态/检索/可见性，直接覆盖当前值。
   */
  async updateEntitySummary(entityId: string, summary: string): Promise<void> {
    const entities = await this.store.nodes.Entity.find();
    const ent = entities.find(
      (e: any) => e.entityId === entityId && e.validTo === INFINITY,
    );
    if (!ent) throw new Error(`Entity ${entityId} not found or already dead`);
    await this.store.nodes.Entity.update(ent.id, { summary });
  }

  async closeRelation(
    sourceId: string,
    targetId: string,
    label: string,
    storyTime: string,
  ): Promise<void> {
    const rels = await this.store.nodes.Relation.find();
    const rel = rels.find(
      (r: any) => r.sourceId === sourceId && r.targetId === targetId
                && r.label === label && r.validTo === INFINITY,
    );
    if (!rel) throw new Error(`Relation ${sourceId}-${label}-${targetId} not found or already closed`);
    await this.store.nodes.Relation.update(rel.id, { validTo: storyTime });
  }

  async getRelations(entityId: string, storyTime: string, opts?: TemporalQueryOpts): Promise<Array<{
    relationId: string;
    sourceId: string;
    targetId: string;
    label: string;
    validFrom: string;
    validTo: string;
  }>> {
    const rels = await this.findNodes("Relation", opts?.recordedAsOf);
    return rels
      .filter((r: any) =>
        (r.sourceId === entityId || r.targetId === entityId)
        && r.validFrom <= storyTime
        && (r.validTo === INFINITY || storyTime < r.validTo),
      )
      .map((r: any) => ({
        relationId: r.relationId,
        sourceId: r.sourceId,
        targetId: r.targetId,
        label: r.label,
        validFrom: r.validFrom,
        validTo: r.validTo,
      }));
  }

  async processEvent(input: EventRecordInput): Promise<void> {
    // 解析并应用默认值（source 缺省为 "engine"），日志中始终落完整记录
    // recordedAt（事务时间轴墙钟）缺省填充当前时间，调用方显式传入时优先
    const event = EventRecord.parse({
      recordedAt: new Date().toISOString(),
      ...input,
    });
    // 写入 JSONL 事件日志（先写日志，确保因果链可回溯）
    await this.eventLog.append(event);

    switch (event.type) {
      case "birth":
        await this.birthEntity(
          event.entityId,
          event.entityType ?? "character",
          Object.fromEntries(
            (event.newFacts ?? []).map((f) => [f.property, f.value]),
          ),
          event.storyTime,
          event.summary,
        );
        break;

      case "death":
        await this.killEntity(event.entityId, event.storyTime);
        break;

      case "change":
        // 闭合旧声明
        for (const inv of event.invalidated ?? []) {
          const facts = await this.store.nodes.Fact.find();
          const oldFact = facts.find(
            (f: any) => f.declarationId === inv.declarationId && f.validTo === INFINITY,
          );
          if (oldFact) {
            await this.store.nodes.Fact.update(oldFact.id, { validTo: event.storyTime });
          }
        }
        // 写入新声明
        for (const fact of event.newFacts ?? []) {
          const declarationId = `decl-${fact.entityId}-${fact.property}-${event.storyTime}`;
          await this.store.nodes.Fact.create({
            declarationId,
            entityId: fact.entityId,
            property: fact.property,
            value: fact.value,
            valueText: String(fact.value),
            modality: fact.modality,
            validFrom: event.storyTime,
            validTo: INFINITY,
          });
        }
        break;
    }
  }

  async traceCauses(eventId: string): Promise<EventRecord[]> {
    return this.eventLog.traceBack(eventId);
  }

  /** 读取所有事件记录（按 storyTime 升序） */
  async getAllEvents(): Promise<EventRecord[]> {
    const all = await this.eventLog.readAll();
    return all.sort((a, b) => a.storyTime.localeCompare(b.storyTime));
  }

  async setVisibility(
    characterId: string,
    declarationId: string,
    opts: {
      state: "known";
      confidence: number;
      source: VisibilitySource; // M1 修复（2026-07-30）：从 string 收窄为枚举
      validFrom: string;
      isExplicit: boolean;
    },
  ): Promise<void> {
    const visibilityId = `vis-${characterId}-${declarationId}-${opts.validFrom}`;
    await this.store.nodes.Visibility.create({
      visibilityId,
      characterId,
      declarationId,
      state: opts.state,
      confidence: opts.confidence,
      source: opts.source,
      validFrom: opts.validFrom,
      validTo: INFINITY,
      isExplicit: opts.isExplicit,
    });
  }

  async getVisibilityForCharacter(characterId: string, storyTime: string, opts?: TemporalQueryOpts): Promise<VisibilityDeclaration[]> {
    const all = await this.findNodes("Visibility", opts?.recordedAsOf);
    return all
      .filter((v: any) => v.characterId === characterId
        && v.validFrom <= storyTime
        && (v.validTo === INFINITY || storyTime < v.validTo))
      .map((v: any) => ({
        characterId: v.characterId,
        declarationId: v.declarationId,
        state: v.state,
        confidence: v.confidence,
        source: v.source,
        validFrom: v.validFrom,
        validTo: v.validTo,
        isExplicit: v.isExplicit,
      })) as VisibilityDeclaration[];
  }

  /**
   * 闭合可见性声明：撤销某角色对某声明的可见性。
   * 找到匹配的未闭合记录（validTo === "Infinity"），闭合之。
   * 实现仿照 closeRelation。
   */
  async closeVisibility(characterId: string, declarationId: string, storyTime: string): Promise<void> {
    const all = await this.store.nodes.Visibility.find();
    const vis = all.find(
      (v: any) => v.characterId === characterId
        && v.declarationId === declarationId
        && v.validTo === INFINITY,
    );
    if (!vis) {
      throw new Error(`Visibility ${characterId}->${declarationId} not found or already closed`);
    }
    await this.store.nodes.Visibility.update(vis.id, { validTo: storyTime });
  }

  /**
   * 反向可见性查询：某条声明被哪些角色可见。
   * 不传 storyTime 返回全部历史（含已闭合），传 storyTime 只返回该时刻有效的。
   */
  async getVisibilityForDeclaration(
    declarationId: string,
    storyTime?: string,
  ): Promise<VisibilityDeclaration[]> {
    const all = await this.store.nodes.Visibility.find();
    return all
      .filter((v: any) => v.declarationId === declarationId)
      .filter((v: any) => !storyTime
        || (v.validFrom <= storyTime && (v.validTo === INFINITY || storyTime < v.validTo)))
      .map((v: any) => ({
        characterId: v.characterId,
        declarationId: v.declarationId,
        state: v.state,
        confidence: v.confidence,
        source: v.source,
        validFrom: v.validFrom,
        validTo: v.validTo,
        isExplicit: v.isExplicit,
      })) as VisibilityDeclaration[];
  }

  async getAllDeclarationsAt(storyTime: string, opts?: TemporalQueryOpts): Promise<StateDeclaration[]> {
    const facts = await this.findNodes("Fact", opts?.recordedAsOf);
    return facts
      .filter((f: any) => f.validFrom <= storyTime
        && (f.validTo === INFINITY || storyTime < f.validTo))
      .map((f: any) => ({
        declarationId: f.declarationId,
        entityId: f.entityId,
        property: f.property,
        value: f.value,
        modality: f.modality,
        validFrom: f.validFrom,
        validTo: f.validTo,
      })) as StateDeclaration[];
  }

  /**
   * 全部声明（不做时态过滤，含已闭合）。
   * 供 character_view 的"知识持续"语义使用：声明闭合后知识不消失。
   */
  async getAllDeclarations(opts?: TemporalQueryOpts): Promise<StateDeclaration[]> {
    const facts = await this.findNodes("Fact", opts?.recordedAsOf);
    return facts
      .map((f: any) => ({
        declarationId: f.declarationId,
        entityId: f.entityId,
        property: f.property,
        value: f.value,
        modality: f.modality,
        validFrom: f.validFrom,
        validTo: f.validTo,
      })) as StateDeclaration[];
  }

  async getAllRelationsAt(storyTime: string, opts?: TemporalQueryOpts): Promise<Array<{
    relationId: string; sourceId: string; targetId: string;
    label: string; validFrom: string; validTo: string;
  }>> {
    const rels = await this.findNodes("Relation", opts?.recordedAsOf);
    return rels
      .filter((r: any) => r.validFrom <= storyTime
        && (r.validTo === INFINITY || storyTime < r.validTo))
      .map((r: any) => ({
        relationId: r.relationId,
        sourceId: r.sourceId,
        targetId: r.targetId,
        label: r.label,
        validFrom: r.validFrom,
        validTo: r.validTo,
      }));
  }

  async inferVisibility(storyTime: string): Promise<void> {
    const { inferVisibility: impl } = await import("./character-view.js");
    await impl(this, storyTime);
  }

  async getCharacterView(
    characterId: string,
    storyTime: string,
    opts: { modalityFilter?: Modality[]; recordedAsOf?: string } = {},
  ): Promise<StateDeclaration[]> {
    const { characterView } = await import("./character-view.js");
    return characterView(this, characterId, storyTime, opts);
  }

  async getAllEntities(storyTime: string, opts?: TemporalQueryOpts): Promise<EntitySnapshot[]> {
    const entities = await this.findNodes("Entity", opts?.recordedAsOf);
    const valid = entities.filter(
      (e: any) => e.validFrom <= storyTime
        && (e.validTo === INFINITY || storyTime < e.validTo),
    );
    const snapshots: EntitySnapshot[] = [];
    for (const ent of valid) {
      const snap = await this.getEntityAt(ent.entityId, storyTime, opts);
      if (snap) snapshots.push(snap);
    }
    return snapshots;
  }

  /**
   * 历史查询：单个实体的全部版本（含已闭合记录），按 validFrom 升序。
   * 返回 Entity 记录数组 + 全部 Fact（含历史），供详情抽屉"历史"页签使用。
   */
  async getEntityHistory(entityId: string): Promise<{
    entities: Array<{
      entityId: string;
      type: EntityType;
      summary: string;
      validFrom: string;
      validTo: string;
    }>;
    facts: Array<StateDeclaration & {
      /** 写入时间（事务时间轴墙钟，SDK meta.createdAt）；旧数据可能缺失 */
      createdAt?: string;
      /** 最后修改时间（如闭合 validTo 的时刻，SDK meta.updatedAt） */
      updatedAt?: string;
    }>;
  }> {
    const entities = await this.store.nodes.Entity.find();
    const ents = entities
      .filter((e: any) => e.entityId === entityId)
      .map((e: any) => ({
        entityId: e.entityId,
        type: e.type,
        summary: e.summary ?? "",
        validFrom: e.validFrom,
        validTo: e.validTo,
      }))
      .sort((a: any, b: any) => a.validFrom.localeCompare(b.validFrom));

    const facts = await this.store.nodes.Fact.find();
    const allFacts = facts
      .filter((f: any) => f.entityId === entityId)
      .map((f: any) => ({
        declarationId: f.declarationId,
        entityId: f.entityId,
        property: f.property,
        value: f.value,
        valueText: f.valueText,
        modality: f.modality,
        validFrom: f.validFrom,
        validTo: f.validTo,
        createdAt: f.meta?.createdAt,
        updatedAt: f.meta?.updatedAt,
      }) as StateDeclaration & { createdAt?: string; updatedAt?: string })
      .sort((a, b) => a.validFrom.localeCompare(b.validFrom));

    return { entities: ents, facts: allFacts };
  }

  /**
   * 关系历史查询（含已闭合）。不传 entityId 返回全部关系。
   */
  async getRelationHistory(entityId?: string): Promise<Array<{
    relationId: string;
    sourceId: string;
    targetId: string;
    label: string;
    validFrom: string;
    validTo: string;
  }>> {
    const rels = await this.store.nodes.Relation.find();
    return rels
      .filter((r: any) => !entityId || r.sourceId === entityId || r.targetId === entityId)
      .map((r: any) => ({
        relationId: r.relationId,
        sourceId: r.sourceId,
        targetId: r.targetId,
        label: r.label,
        validFrom: r.validFrom,
        validTo: r.validTo,
      }))
      .sort((a, b) => a.validFrom.localeCompare(b.validFrom));
  }

  /**
   * 列出所有出现过的 storyTime（从 events + Entity/Fact/Relation/Visibility 的 validFrom/validTo 聚合）。
   * 去重升序，供前端 storyTime 快照选择器使用。
   * "Infinity" 被排除（它不是真实时刻）。
   */
  async listStoryTimes(): Promise<string[]> {
    const times = new Set<string>();
    const events = await this.eventLog.readAll();
    for (const e of events) {
      times.add(e.storyTime);
    }
    for (const nodeName of ["Entity", "Fact", "Relation", "Visibility"] as const) {
      const records = await (this.store.nodes as any)[nodeName].find();
      for (const r of records) {
        if (r.validFrom && r.validFrom !== INFINITY) times.add(r.validFrom);
        if (r.validTo && r.validTo !== INFINITY) times.add(r.validTo);
      }
    }
    return Array.from(times).sort((a, b) => a.localeCompare(b));
  }

  /**
   * 重新嵌入所有 Entity 与 Fact 的 embedding 向量。
   *
   * - Entity：用其 validFrom（诞生时刻）取快照，传入 embedEntity 得到向量
   * - Fact：直接构造 StateDeclaration 传入 embedFact 得到向量
   *
   * [存疑] Entity embedding 用诞生时刻快照，不包含后续变更的 properties；
   * 若需"当前态"语义应改用 INFINITY 查询。当前遵循 Task 0.2 规格用 validFrom。
   *
   * embedding 字段在 SDK 中是 branded type（EmbeddingValue），embedder 返回 number[]，
   * 此处经 unknown 双重断言绕过 brand 检查（运行时仍为 number[]）。
   */
  async reembedAll(embedder: {
    embedEntity(snap: EntitySnapshot): Promise<number[]>;
    embedFact(decl: StateDeclaration): Promise<number[]>;
  }): Promise<void> {
    const entities = await this.store.nodes.Entity.find();
    for (const ent of entities) {
      const snap = await this.getEntityAt(ent.entityId, ent.validFrom);
      if (snap) {
        const vec = await embedder.embedEntity(snap);
        await this.store.nodes.Entity.update(ent.id, {
          embedding: vec as unknown as EmbeddingValue,
        });
      }
    }
    const facts = await this.store.nodes.Fact.find();
    for (const f of facts) {
      const decl: StateDeclaration = {
        declarationId: f.declarationId,
        entityId: f.entityId,
        property: f.property,
        value: f.value,
        valueText: f.valueText,
        modality: f.modality,
        validFrom: f.validFrom,
        validTo: f.validTo,
      };
      const vec = await embedder.embedFact(decl);
      await this.store.nodes.Fact.update(f.id, {
        embedding: vec as unknown as EmbeddingValue,
      });
    }
  }

  /**
   * 更新单条 Fact 的 embedding（P0-5 修复，2026-07-27）
   *
   * commit.ts 写扩散后增量更新向量，避免全量 reembedAll 的性能开销。
   * 找不到 declarationId 对应的 Fact 时不抛错（兼容导入器遗留数据）。
   *
   * @param declarationId Fact 主键
   * @param embedding 512 维归一化向量
   *
   * TODO（P3 性能优化，子代理审查建议）：
   *   当前 `this.store.nodes.Fact.find()` 是全表扫描。Fact 表大时（>1000 条）
   *   每次 commit 都全表扫 N 次（N=state_changes 数）。
   *   初期保持简单跑数据，视性能决定是否用 SDK query() 建 declarationId 索引。
   */
  async updateFactEmbedding(declarationId: string, embedding: number[]): Promise<void> {
    const facts = await this.store.nodes.Fact.find();
    // 不做类型断言，让 TS 推断 SDK 返回的 id 字段类型（NodeId branded type）
    const fact = facts.find((f) => f.declarationId === declarationId);
    if (!fact) return; // 静默跳过（兼容性，不抛错）
    await this.store.nodes.Fact.update(fact.id, {
      embedding: embedding as unknown as EmbeddingValue,
    });
  }

  /**
   * 更新单条 Entity 的 embedding（P0-5 修复，备用 API）
   *
   * Entity.summary 变化时调用。当前 commit.ts 不修改 summary，
   * 此方法预留给未来 updateEntitySummary 路径使用。
   *
   * @param entityId 实体 ID（取 validTo=INFINITY 的当前版本）
   * @param embedding 512 维归一化向量
   */
  async updateEntityEmbedding(entityId: string, embedding: number[]): Promise<void> {
    const entities = await this.store.nodes.Entity.find();
    // 不做类型断言，让 TS 推断 SDK 返回的 id 字段类型（NodeId branded type）
    const ent = entities.find(
      (e) => e.entityId === entityId && e.validTo === INFINITY,
    );
    if (!ent) return; // 静默跳过（兼容性）
    await this.store.nodes.Entity.update(ent.id, {
      embedding: embedding as unknown as EmbeddingValue,
    });
  }
}
