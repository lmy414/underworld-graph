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
import type {
  HistoryStore,
  EmbeddingValue,
  RecordedInstant,
  GraphNodeCollections,
  TransactionContext,
} from "@nicia-ai/typegraph";
import {
  createSqliteBackend,
  generateSqliteMigrationSQL,
} from "@nicia-ai/typegraph/adapters/drizzle/sqlite";
import { getActiveSchema, migrateSchema } from "@nicia-ai/typegraph/schema";
import { z } from "zod";
import { EntityType, Modality, EventRecord, VisibilitySource, INFINITY } from "./types.js";
import type { StateDeclaration, VisibilityDeclaration, EventRecordInput } from "./types.js";
import { EventLog } from "./event-log.js";

/**
 * 把 number[] 断言为 SDK 的 EmbeddingValue branded type。
 *
 * SDK 的 EmbeddingValue = `readonly number[] & { [EMBEDDING_BRAND]: true }`，
 * 是编译期 brand，运行时仍是 number[]。embedder 返回 number[]，需经 unknown
 * 双重断言绕过 brand 检查。集中到此 helper，避免散落的 `as unknown as`。
 */
function asEmbedding(vec: number[]): EmbeddingValue {
  return vec as unknown as EmbeddingValue;
}

/**
 * 内部节点记录类型 — SDK 节点 find/scan 返回值的并集。
 *
 * SDK 的节点类型是 branded NodeId + mapped type，动态访问
 * `(this.store.nodes as any)[kind]` 无法保留精确类型，故定义此宽松接口。
 * 各字段均 optional（不同节点类型字段不同），调用方按需读取。
 * id 字段：SDK 的 NodeIdentifier = string | {id: string}，故 string 兼容。
 */
interface GraphRecord {
  id: string;
  // Entity
  entityId?: string;
  type?: EntityType;
  name?: string;
  aliases?: string[];
  summary?: string;
  // Fact
  declarationId?: string;
  property?: string;
  description?: string;
  modality?: Modality;
  // Relation
  relationId?: string;
  sourceId?: string;
  targetId?: string;
  label?: string;
  // Visibility
  characterId?: string;
  state?: "known";
  confidence?: number;
  source?: VisibilitySource;
  isExplicit?: boolean;
  // 公共时态字段（所有节点类型必填）
  validFrom: string;
  validTo: string;
  // SDK 元信息
  embedding?: EmbeddingValue;
  meta?: { createdAt?: string; updatedAt?: string };
}

/**
 * TypeGraph 节点定义 — Entity（实体）与 Fact（状态声明）
 * validFrom/validTo 作为 schema 字段，由应用层管理 bi-temporal 语义
 * "Infinity" 表示未闭合
 */
const EntityNode = defineNode("Entity", {
  schema: z.object({
    entityId: z.string(),
    type: EntityType,
    /**
     * 0.3.0：展示快照（可视化直接读取，前端不再 fallback properties.名字 || entityId）。
     * 非权威——改名历史/可见性/检索仍由 Fact property="名字" 承载。
     */
    name: z.string().default(""),
    /** 0.3.0：别名快照，同 name 语义；由引擎侧维护（计划 §九.4） */
    aliases: z.array(z.string()).default([]),
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
    /** 0.3.0：状态内容文本（替代 value/valueText，searchable 进全文索引） */
    description: searchable({ language: "zh" }),
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
    /**
     * 0.3.0：叙事描述——label 收窄为简单类型词（检索/闭合键）后，长句描述归位到此
     */
    description: z.string().default(""),
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

/**
 * declares 边（Entity → Fact）— 预留定义，当前未使用。
 *
 * 现状：birthEntity / processEvent 写 Fact 时不创建 declares 边，
 * 查询也不走边遍历。保留定义是为了未来知识图谱遍历需求。
 *
 * 注意：删除此边定义会改变 graph schema_hash，触发旧库 MIGRATION_ERROR，
 * 故即使未用也不要删除，待真正启用或显式走 schema 迁移时再调整。
 */
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

/**
 * 节点集合访问器 — `store.nodes` 与事务上下文 `tx.nodes` 同构
 * （GraphNodeCollections<typeof graph>），写入方法按此抽象路由：
 * 公开方法走 store.nodes（单步写），processEvent 事务内走 tx.nodes（多步写原子）。
 */
type NodeAccessor = GraphNodeCollections<typeof graph>;

export interface WorldGraphOptions {
  dbPath: string;
  eventLogPath: string;
  /**
   * storyTime 可选格式校验（D1 台账修复，2026-08-07）。
   *
   * 设置后所有写入入口（birthEntity / killEntity / addRelation / closeRelation /
   * processEvent / setVisibility / updateEntitySummary 等接受 storyTime 的方法）
   * 会校验 storyTime，不匹配抛带 pattern 信息的 Error。缺省不校验
   * （通用库，不强制格式；时态过滤依赖字典序，格式约束由消费方自定）。
   *
   * 推荐消费方 narrative-engine 使用 `/^ch\d{3}\.ev\d{3}$/`。
   */
  storyTimePattern?: RegExp;
  /**
   * 可选 embedder（D5 台账修复，2026-08-07）。
   * 配置后 updateEntitySummary 会触发该实体的重嵌入；缺省时静默跳过。
   */
  embedder?: {
    embedEntity(snap: EntitySnapshot): Promise<number[]>;
    embedFact(decl: StateDeclaration): Promise<number[]>;
  };
}

/** WorldGraph.migrate 返回的迁移结果 */
export interface MigrateResult {
  /** 迁移前激活的 schema 版本 */
  fromVersion: number;
  /** 迁移后的 schema 版本 */
  toVersion: number;
}

/**
 * birthEntity 的额外声明（D2/D3 台账修复，2026-08-07）。
 * entityId 缺省时回退事件主实体（由调用方保证填充）；modality 缺省 "fact"。
 * 0.3.0：value → description（string 契约，见 StateDeclaration）。
 */
export interface BirthExtraFact {
  entityId: string;
  property: string;
  description: string;
  modality?: Modality;
}

/**
 * 0.3.0：Entity.name 展示快照的来源 property 约定（规则集中文词表）。
 * birth/改名 change 事件中 property === NAME_PROPERTY 的 Fact 同步写 Entity.name；
 * 快照非权威，改名历史/可见性/检索仍由该 Fact 承载。
 */
const NAME_PROPERTY = "名字";

export interface EntitySnapshot {
  entityId: string;
  type: EntityType;
  /** 0.3.0：展示快照（非权威），缺省 "" */
  name: string;
  /** 0.3.0：别名快照，缺省 [] */
  aliases: string[];
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
  /** D1：storyTime 格式校验（可选），见 WorldGraphOptions.storyTimePattern */
  private storyTimePattern?: RegExp;
  /** D5：可选 embedder，updateEntitySummary 时触发重嵌入 */
  private embedder?: WorldGraphOptions["embedder"];
  /**
   * updateEntitySummary 事件 ID 自增序号（复核修复，2026-08-07）：
   * Date.now() 同毫秒重复调用会撞键，叠加实例级序号保证唯一。
   */
  private _summaryEventSeq = 0;
  /**
   * 写入互斥锁 — processEvent 是多步异步操作（append 日志 + 多次 store 写），
   * 并发调用会交错导致状态不一致。此 Promise 链保证 processEvent 串行执行。
   *
   * 范围说明：当前只锁 processEvent。birthEntity / killEntity / setVisibility 等
   * 单一写入方法未加锁；若外部混用 processEvent 与这些方法，仍可能交错。
   * 完整的写入隔离需要消费方自行避免并发混用，或后续扩展锁覆盖所有写入方法。
   */
  private _writeLock: Promise<void> = Promise.resolve();

  private constructor(
    db: Database.Database,
    store: HistoryStore<typeof graph>,
    eventLog: EventLog,
    options?: Pick<WorldGraphOptions, "storyTimePattern" | "embedder">,
  ) {
    this.db = db;
    this.store = store;
    this.eventLog = eventLog;
    this.storyTimePattern = options?.storyTimePattern;
    this.embedder = options?.embedder;
  }

  /**
   * D1：storyTime 格式校验。仅在配置了 storyTimePattern 时生效，
   * 不匹配抛带 pattern 信息的 Error；缺省不校验。
   */
  private assertStoryTime(storyTime: string): void {
    if (this.storyTimePattern && !this.storyTimePattern.test(storyTime)) {
      throw new Error(
        `storyTime "${storyTime}" 不匹配配置的格式 ${this.storyTimePattern}`,
      );
    }
  }

  /**
   * 串行执行异步写操作。后续调用会等待前一个完成后再开始。
   * 仅用于内部 processEvent，不改变公共 API 语义。
   */
  private async withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this._writeLock;
    let release!: () => void;
    this._writeLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * 在 SDK store 事务内执行一组写入。
   *
   * 修复（2026-08-05）：processEvent 的 birth/change 本质是多步 store 写
   * （Entity + N 条 Fact / 闭合旧声明 + 写入新声明），中途失败会留下半更新状态。
   * `store.transaction` 是 TypeGraph 官方事务入口，回调内读写必须走 tx 上下文
   * （tx.nodes），不能穿插 store 直读（同后端会 deadlock，SDK 显式报错）。
   *
   * 语义：JSONL 先写入（审计因果链），DB 状态在此事务内原子提交。
   * 若 DB 提交失败，事件仍留在日志中（标记"曾尝试"），可被消费方对账。
   */
  private runInTransaction<T>(
    fn: (tx: TransactionContext<typeof graph>) => Promise<T>,
  ): Promise<T> {
    return this.store.transaction(fn);
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
      return new WorldGraph(db, store, eventLog, opts);
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
   * C1 台账修复（2026-08-07）：签名与 create 对称，接受完整 WorldGraphOptions
   * 或仅 `{ dbPath }`（迁移只读 db 文件，eventLogPath 等字段被忽略）。
   *
   * @returns 迁移前后的 schema 版本号
   */
  static async migrate(opts: WorldGraphOptions | { dbPath: string }): Promise<MigrateResult> {
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
    this.eventLog.close();
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
   *
   * B5（2026-08-07）：live 路径支持 where 谓词 SQL 下推（SDK find 的
   * { where } 选项），替代"取全量 + JS filter"的全表扫描。谓词仅用于
   * 缩小扫描范围，调用方仍保留 JS 过滤保证精确语义（含 recordedAsOf 路径，
   * RecordedStoreView.scan 不支持谓词，该路径谓词被忽略）。
   * kind 是动态访问，where 的 accessor 类型无法精确表达，故标 any
   * （SDK 类型边界的已知限制，与下方 find() 的 as any 同理）。
   */
  private async findNodes(
    kind: "Entity" | "Fact" | "Relation" | "Visibility",
    recordedAsOf?: string,
    where?: (accessor: any) => unknown,
  ): Promise<GraphRecord[]> {
    if (!recordedAsOf) {
      // SDK 的 nodes 是 mapped type，动态 [kind] 访问无法保留精确类型，
      // 此处 as any 是 SDK 类型边界的已知限制，返回值统一断言为 GraphRecord[]。
      return await (this.store.nodes as any)[kind].find(
        where ? { where } : undefined,
      ) as GraphRecord[];
    }
    const view = this.store.asOfRecorded(recordedAsOf as RecordedInstant);
    const collection = (view.nodes as any)[kind];
    const out: GraphRecord[] = [];
    let after: string | undefined;
    do {
      const page = await collection.scan({ limit: 1000, after });
      out.push(...(page.data as GraphRecord[]));
      after = page.nextCursor;
    } while (after);
    return out;
  }

  /**
   * 诞生实体。
   *
   * @param initialProps 初始属性（Record，逐条写 Fact，modality 固定 "fact"）
   * @param extraFacts 额外声明（D2/D3 台账修复，2026-08-07）：逐条写 Fact，
   *   透传 f.entityId（支持跨实体声明）与 f.modality（缺省 "fact"）。
   *   同 property 多条全部保留，声明 ID 冲突规则见 birthEntityCore。
   * @param opts.strict C4 严格模式：entityId 已存活时抛错（缺省 false 保持原行为）
   */
  async birthEntity(
    entityId: string,
    entityType: EntityType,
    initialProps: Record<string, unknown>,
    storyTime: string,
    summary?: string,
    extraFacts?: BirthExtraFact[],
    opts?: { strict?: boolean },
  ): Promise<void> {
    this.assertStoryTime(storyTime);
    await this.birthEntityCore(
      this.store.nodes,
      entityId,
      entityType,
      initialProps,
      storyTime,
      summary,
      extraFacts,
      opts,
    );
  }

  /**
   * 幂等诞生（C3 台账修复，2026-08-07）：同 birthEntity 签名；
   * 若该 entityId 已有未闭合 Entity，则跳过创建（幂等返回，不抛错），
   * 否则走正常 birth。供上层重试逻辑使用，避免重复记录。
   */
  async birthEntityUpsert(
    entityId: string,
    entityType: EntityType,
    initialProps: Record<string, unknown>,
    storyTime: string,
    summary?: string,
    extraFacts?: BirthExtraFact[],
    opts?: { strict?: boolean },
  ): Promise<void> {
    this.assertStoryTime(storyTime);
    const alive = await this.store.nodes.Entity.find({
      where: (e) => e.entityId.eq(entityId).and(e.validTo.eq(INFINITY)),
    });
    if (alive.length > 0) return; // 幂等：已存活则跳过
    await this.birthEntity(
      entityId,
      entityType,
      initialProps,
      storyTime,
      summary,
      extraFacts,
      opts,
    );
  }

  /**
   * birthEntity 实际写入逻辑：可走 store.nodes（公开方法）或 tx.nodes（processEvent 事务内）
   *
   * 声明 ID 冲突规则（D2，2026-08-07）：同一批写入中同一 (entityId, property)
   * 出现多条时，首条保持旧格式 `decl-{entityId}-{property}-{storyTime}`
   * （存量数据 ID 稳定，硬约束），第 2、3… 条追加后缀 `-2`、`-3`。
   * initialProps 与 extraFacts 合并计数。
   *
   * 0.3.0：name 展示快照从 initialProps/extraFacts 的 NAME_PROPERTY（"名字"）提取，
   * 写入 Entity.name；aliases 无来源（引擎侧维护），缺省 []。
   */
  private async birthEntityCore(
    nodes: NodeAccessor,
    entityId: string,
    entityType: EntityType,
    initialProps: Record<string, unknown>,
    storyTime: string,
    summary?: string,
    extraFacts?: BirthExtraFact[],
    opts?: { strict?: boolean },
  ): Promise<void> {
    if (opts?.strict) {
      // C4 严格模式：entityId 不得已存活
      const alive = await nodes.Entity.find({
        where: (e) => e.entityId.eq(entityId).and(e.validTo.eq(INFINITY)),
      });
      if (alive.length > 0) {
        throw new Error(`strict: Entity ${entityId} 已存活，birthEntity 拒绝重复诞生`);
      }
    }
    // 0.3.0：name 快照提取（initialProps 优先，extraFacts 兜底；非 string 不落快照）
    const nameFromProps = initialProps[NAME_PROPERTY];
    const nameSnapshot = typeof nameFromProps === "string"
      ? nameFromProps
      : (extraFacts?.find((f) => f.property === NAME_PROPERTY)?.description ?? "");
    // 0.3.0：description 是 string 契约——写入前整体校验，避免 Entity 已建后中途抛错
    // 留下半成品（拒绝 [object Object] 垃圾文本进全文索引）
    const validatedProps: Record<string, string> = {};
    for (const [prop, val] of Object.entries(initialProps)) {
      if (typeof val !== "string") {
        throw new Error(
          `0.3.0: initialProps["${prop}"] 的值必须是 string（StateDeclaration.description 契约，不再支持任意类型 value）`,
        );
      }
      validatedProps[prop] = val;
    }
    await nodes.Entity.create({
      entityId,
      type: entityType,
      name: nameSnapshot,
      aliases: [],  // 0.3.0：别名快照由引擎侧维护（计划 §九.4），包内暂无来源
      summary: summary ?? "",
      validFrom: storyTime,
      validTo: INFINITY,
    });
    // 同批 (entityId, property) 计数器：首条旧格式，次条起追加 -N
    const declCounts = new Map<string, number>();
    const nextDeclId = (targetEntityId: string, property: string): string => {
      const key = `${targetEntityId}::${property}`;
      const n = (declCounts.get(key) ?? 0) + 1;
      declCounts.set(key, n);
      const base = `decl-${targetEntityId}-${property}-${storyTime}`;
      return n === 1 ? base : `${base}-${n}`;
    };
    for (const [prop, val] of Object.entries(validatedProps)) {
      await nodes.Fact.create({
        declarationId: nextDeclId(entityId, prop),
        entityId,
        property: prop,
        description: val,
        modality: "fact",
        validFrom: storyTime,
        validTo: INFINITY,
      });
    }
    // D2/D3：extraFacts 逐条写 Fact，透传 entityId（缺省回退主实体）与 modality（缺省 "fact"）
    for (const f of extraFacts ?? []) {
      const targetEntityId = f.entityId ?? entityId;
      await nodes.Fact.create({
        declarationId: nextDeclId(targetEntityId, f.property),
        entityId: targetEntityId,
        property: f.property,
        description: f.description,
        modality: f.modality ?? "fact",
        validFrom: storyTime,
        validTo: INFINITY,
      });
    }
  }

  async killEntity(entityId: string, storyTime: string): Promise<void> {
    this.assertStoryTime(storyTime);
    await this.killEntityCore(this.store.nodes, entityId, storyTime);
  }

  /** killEntity 实际写入逻辑：可走 store.nodes（公开方法）或 tx.nodes（processEvent 事务内） */
  private async killEntityCore(nodes: NodeAccessor, entityId: string, storyTime: string): Promise<void> {
    // B5（2026-08-07）：where 谓词 SQL 下推替代 find() 全表扫描 + JS filter
    const entities = await nodes.Entity.find({
      where: (e) => e.entityId.eq(entityId).and(e.validTo.eq(INFINITY)),
    });
    const ent = entities[0];
    if (!ent) throw new Error(`Entity ${entityId} not found or already dead`);
    await nodes.Entity.update(ent.id, { validTo: storyTime });
    // 级联关闭该实体所有未闭合 Fact
    const facts = await nodes.Fact.find({
      where: (f) => f.entityId.eq(entityId).and(f.validTo.eq(INFINITY)),
    });
    for (const f of facts) {
      await nodes.Fact.update(f.id, { validTo: storyTime });
    }
    // D4（2026-08-07）：级联闭合该实体所有未闭合 Relation（source 或 target 匹配），
    // 与 Fact 级联同事务；死亡实体不再出现在关系查询，inferVisibility 不再为死者推断。
    const rels = await nodes.Relation.find({
      where: (r) => r.sourceId.eq(entityId).or(r.targetId.eq(entityId)),
    });
    for (const r of rels) {
      if (r.validTo === INFINITY) {
        await nodes.Relation.update(r.id, { validTo: storyTime });
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
    // 注意：此处不做 where 下推 —— getAllEntities（B5 内存分组）按全扫顺序组装
    // properties，getEntityAt 保持同一路径保证两者输出顺序完全一致（回归测试锁定）。
    const entities = await this.findNodes("Entity", opts?.recordedAsOf);
    const ent = entities.find(
      (e) =>
        e.entityId === entityId &&
        e.validFrom <= storyTime &&
        (e.validTo === INFINITY || storyTime < e.validTo),
    );
    if (!ent) return null;
    const facts = await this.findNodes("Fact", opts?.recordedAsOf);
    const props = facts
      .filter(
        (f) =>
          f.entityId === entityId &&
          f.validFrom <= storyTime &&
          (f.validTo === INFINITY || storyTime < f.validTo),
      )
      .map(
        (f) =>
          ({
            declarationId: f.declarationId,
            entityId: f.entityId,
            property: f.property,
            description: f.description ?? "",
            modality: f.modality,
            validFrom: f.validFrom,
            validTo: f.validTo,
          }) as StateDeclaration,
      );
    return {
      entityId,
      type: ent.type!,
      name: ent.name ?? "",
      aliases: ent.aliases ?? [],
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
    opts?: { strict?: boolean; description?: string },
  ): Promise<void> {
    this.assertStoryTime(storyTime);
    if (opts?.strict) {
      // C4 严格模式：两端实体必须存在且存活
      for (const id of [sourceId, targetId]) {
        const alive = await this.store.nodes.Entity.find({
          where: (e) => e.entityId.eq(id).and(e.validTo.eq(INFINITY)),
        });
        if (alive.length === 0) {
          throw new Error(`strict: addRelation 端点实体 ${id} 不存在或已死亡`);
        }
      }
    }
    const relationId = `rel-${sourceId}-${label}-${targetId}-${storyTime}`;
    await this.store.nodes.Relation.create({
      relationId,
      sourceId,
      targetId,
      label,
      // 0.3.0：叙事描述（label 收窄为简单类型词后长句归位到此）
      description: opts?.description ?? "",
      validFrom: storyTime,
      validTo: INFINITY,
    });
  }

  /**
   * 更新实体摘要（D5 台账修复，2026-08-07，破坏性：storyTime 变为必填）。
   *
   * 行为：
   * 1. 写一条 change 事件到事件日志（复用 EventRecord.summary 字段，
   *    newFacts/invalidated 为空，source 默认 "engine"），summary 变更可回溯；
   * 2. 覆盖更新当前 Entity.summary（原语义不变）；
   * 3. 若配置了 embedder（WorldGraphOptions.embedder），触发该实体的重嵌入
   *    （复用 updateEntityEmbedding）；无 embedder 时静默跳过。
   *
   * 一致性语义参考 _processEvent：先日志后状态。若实体不存在，事件仍留在
   * 日志中（审计语义，与 processEvent 失败事件保留一致）。
   */
  async updateEntitySummary(entityId: string, summary: string, storyTime: string): Promise<void> {
    this.assertStoryTime(storyTime);
    // recordedAt 与 _processEvent 同口径（D8：SDK 事务时钟坐标）
    const recordedAt = await this.recordedNow();
    // eventId：墙钟毫秒 + 实例级自增序号，同毫秒重复调用不撞键
    const seq = ++this._summaryEventSeq;
    await this.eventLog.append({
      eventId: `evt_summary_${entityId}_${storyTime}_${Date.now()}_${seq}`,
      type: "change",
      storyTime,
      entityId,
      summary,
      ...(recordedAt ? { recordedAt } : {}),
    });
    // B5：where 谓词下推替代全表扫描
    const entities = await this.store.nodes.Entity.find({
      where: (e) => e.entityId.eq(entityId).and(e.validTo.eq(INFINITY)),
    });
    const ent = entities[0];
    if (!ent) throw new Error(`Entity ${entityId} not found or already dead`);
    await this.store.nodes.Entity.update(ent.id, { summary });
    // 配置了 embedder 时触发重嵌入；未配置静默跳过
    if (this.embedder) {
      const snap = await this.getEntityAt(entityId, storyTime);
      if (snap) {
        const vec = await this.embedder.embedEntity(snap);
        await this.updateEntityEmbedding(entityId, vec);
      }
    }
  }

  async closeRelation(
    sourceId: string,
    targetId: string,
    label: string,
    storyTime: string,
  ): Promise<void> {
    this.assertStoryTime(storyTime);
    // B5：where 谓词下推替代全表扫描
    const rels = await this.store.nodes.Relation.find({
      where: (r) => r.sourceId.eq(sourceId).and(r.targetId.eq(targetId))
        .and(r.label.eq(label)).and(r.validTo.eq(INFINITY)),
    });
    const rel = rels[0];
    if (!rel) throw new Error(`Relation ${sourceId}-${label}-${targetId} not found or already closed`);
    await this.store.nodes.Relation.update(rel.id, { validTo: storyTime });
  }

  async getRelations(entityId: string, storyTime: string, opts?: TemporalQueryOpts): Promise<Array<{
    relationId: string;
    sourceId: string;
    targetId: string;
    label: string;
    description: string;
    validFrom: string;
    validTo: string;
  }>> {
    // B5：live 路径 where 下推（source 或 target 匹配），JS 过滤保留精确时态语义
    const rels = await this.findNodes(
      "Relation",
      opts?.recordedAsOf,
      (r) => r.sourceId.eq(entityId).or(r.targetId.eq(entityId)),
    );
    return rels
      .filter((r) =>
        (r.sourceId === entityId || r.targetId === entityId)
        && r.validFrom <= storyTime
        && (r.validTo === INFINITY || storyTime < r.validTo),
      )
      .map((r) => ({
        relationId: r.relationId!,
        sourceId: r.sourceId!,
        targetId: r.targetId!,
        label: r.label!,
        description: r.description ?? "",
        validFrom: r.validFrom,
        validTo: r.validTo,
      }));
  }

  async processEvent(input: EventRecordInput & { strict?: boolean }): Promise<void> {
    // 串行化：多步异步写（append 日志 + 多次 store 写）并发会交错，
    // 用 _writeLock 保证 processEvent 调用依次执行。
    return this.withWriteLock(() => this._processEvent(input));
  }

  private async _processEvent(input: EventRecordInput & { strict?: boolean }): Promise<void> {
    this.assertStoryTime(input.storyTime);
    // C4：strict 只影响校验行为，不进 zod schema、不落事件日志 —— parse 前剥离
    const { strict, ...eventInput } = input;
    // 解析并应用默认值（source 缺省为 "engine"），日志中始终落完整记录。
    // D8（2026-08-07）：recordedAt（事务时间轴）缺省值从墙钟 ISO 改为 SDK
    // 事务时钟坐标（recordedNow()，形如 "r1:0000000000000007:..."），与双时态
    // 查询的事务时间轴统一。坐标取本事件提交前的最近提交点（本事件的提交坐标
    // 在提交前不可知）；空图首次写入时无坐标，recordedAt 缺省不落。
    // 已知不一致：旧日志行的 recordedAt 是 ISO 墙钟，新行是 recorded 坐标。
    // 调用方显式传入 recordedAt 时仍优先（展开顺序保证 input 覆盖缺省值）。
    const recordedAt = await this.recordedNow();
    const event = EventRecord.parse({
      ...(recordedAt ? { recordedAt } : {}),
      ...eventInput,
    });
    // 写入 JSONL 事件日志（先写日志，确保因果链可回溯）
    await this.eventLog.append(event);
    // DB 状态写入包 SDK store 事务：失败整体回滚，不留下半更新。
    // 事务内所有读写必须走 tx 上下文（穿插 store 直读会 deadlock，SDK 显式报错）。
    await this.runInTransaction((tx) => this._applyEvent(tx, event, strict ?? false));
  }

  /** processEvent 的 DB 写入部分（仅在 store 事务内调用，读写均走 tx） */
  private async _applyEvent(
    tx: TransactionContext<typeof graph>,
    event: EventRecord,
    strict = false,
  ): Promise<void> {
    switch (event.type) {
      case "birth":
        // D2/D3（2026-08-07）：弃用 Object.fromEntries（同 property 多条互相覆盖、
        // f.entityId 被忽略、modality 硬编码 "fact"）。改为 newFacts 逐条映射为
        // extraFacts 传给 birthEntityCore：f.entityId 缺省填事件主 entityId，
        // modality 透传（缺省 "fact" 由 core 处理），同 property 多条全部保留。
        await this.birthEntityCore(
          tx.nodes,
          event.entityId,
          event.entityType ?? "character",
          {},
          event.storyTime,
          event.summary,
          (event.newFacts ?? []).map((f) => ({
            entityId: f.entityId ?? event.entityId,
            property: f.property,
            description: f.description,
            modality: f.modality,
          })),
          // C4：strict 透传 —— 严格模式下实体已存活时 birthEntityCore 抛错
          { strict },
        );
        break;

      case "death":
        await this.killEntityCore(tx.nodes, event.entityId, event.storyTime);
        break;

      case "change":
        // C4 严格模式：newFacts 的 entityId 必须存在且存活；
        // invalidated 的 declarationId 必须存在且未闭合（缺省 false 时悬空引用静默跳过，原行为）
        if (strict) {
          for (const fact of event.newFacts ?? []) {
            const alive = await tx.nodes.Entity.find({
              where: (e) => e.entityId.eq(fact.entityId).and(e.validTo.eq(INFINITY)),
            });
            if (alive.length === 0) {
              throw new Error(`strict: change newFacts 的 entityId ${fact.entityId} 不存在或已死亡`);
            }
          }
          for (const inv of event.invalidated ?? []) {
            const targets = await tx.nodes.Fact.find({
              where: (f) => f.declarationId.eq(inv.declarationId).and(f.validTo.eq(INFINITY)),
            });
            if (targets.length === 0) {
              throw new Error(`strict: change invalidated 的 declarationId ${inv.declarationId} 不存在或已闭合`);
            }
            // invalidated[].property 一致性校验：非 strict 路径从不读取该字段，
            // strict 模式下核对它与声明实际 property 一致，防止误闭合
            if (targets[0].property !== inv.property) {
              throw new Error(`strict: change invalidated 的 declarationId ${inv.declarationId} property 不匹配（声明实际为 ${targets[0].property}，事件填 ${inv.property}）`);
            }
          }
        }
        // 闭合旧声明（B5：where 谓词下推替代全表扫描）
        for (const inv of event.invalidated ?? []) {
          const facts = await tx.nodes.Fact.find({
            where: (f) => f.declarationId.eq(inv.declarationId).and(f.validTo.eq(INFINITY)),
          });
          const oldFact = facts[0];
          if (oldFact) {
            await tx.nodes.Fact.update(oldFact.id, { validTo: event.storyTime });
          }
        }
        // 写入新声明（0.3.0：value → description，string 契约）
        for (const fact of event.newFacts ?? []) {
          const declarationId = `decl-${fact.entityId}-${fact.property}-${event.storyTime}`;
          await tx.nodes.Fact.create({
            declarationId,
            entityId: fact.entityId,
            property: fact.property,
            description: fact.description,
            modality: fact.modality,
            validFrom: event.storyTime,
            validTo: INFINITY,
          });
          // 0.3.0：改名（property=名字）同步 Entity.name 展示快照（计划 §五 同步规则，
          // 与 updateEntitySummary 同模式：引擎写名字 Fact，包内同步快照字段）
          if (fact.property === NAME_PROPERTY) {
            const ents = await tx.nodes.Entity.find({
              where: (e) => e.entityId.eq(fact.entityId).and(e.validTo.eq(INFINITY)),
            });
            if (ents[0]) {
              await tx.nodes.Entity.update(ents[0].id, { name: fact.description });
            }
          }
        }
        break;
    }
  }

  /**
   * 因果链回溯（D7 台账修复，2026-08-07，破坏性：返回类型加 null）。
   *
   * 语义区分：
   * - eventId 本身不存在 → 返回 null（"查无此事件"）
   * - 事件存在但因果链上某 causedBy 指向不存在的 eventId（前驱丢失）→ 抛 Error，
   *   消息含悬空 eventId
   * - 根因事件（无 causedBy）→ 返回 [event, ...]，保持原状
   */
  async traceCauses(eventId: string): Promise<EventRecord[] | null> {
    const all = await this.eventLog.readAll();
    const byId = new Map(all.map((e) => [e.eventId, e]));
    const start = byId.get(eventId);
    if (!start) return null;
    const chain: EventRecord[] = [];
    // 因果环保护：日志损坏出现 causedBy 环时抛错而非无限循环
    const visited = new Set<string>([eventId]);
    let cur: EventRecord | undefined = start;
    while (cur) {
      chain.unshift(cur);
      const causedBy = cur.causedBy;
      if (!causedBy) break;
      const prev = byId.get(causedBy);
      if (!prev) {
        throw new Error(`traceCauses: 因果链前驱丢失，causedBy 指向不存在的 eventId: ${causedBy}`);
      }
      if (visited.has(prev.eventId)) {
        throw new Error(`traceCauses: 因果链存在环，eventId ${prev.eventId} 被重复访问`);
      }
      visited.add(prev.eventId);
      cur = prev;
    }
    return chain;
  }

  /** 读取所有事件记录（按 storyTime 升序） */
  async getAllEvents(): Promise<EventRecord[]> {
    const all = await this.eventLog.readAll();
    return all.sort((a, b) => a.storyTime.localeCompare(b.storyTime));
  }

  async setVisibility(
    characterId: string,
    declarationId: string,
    visOpts: {
      state: "known";
      confidence: number;
      source: VisibilitySource; // M1 修复（2026-07-30）：从 string 收窄为枚举
      validFrom: string;
      isExplicit: boolean;
    },
    strictOpts?: { strict?: boolean },
  ): Promise<void> {
    this.assertStoryTime(visOpts.validFrom);
    if (strictOpts?.strict) {
      // C4 严格模式：declarationId 必须存在（含已闭合的历史声明）
      const facts = await this.store.nodes.Fact.find({
        where: (f) => f.declarationId.eq(declarationId),
      });
      if (facts.length === 0) {
        throw new Error(`strict: setVisibility 的 declarationId ${declarationId} 不存在`);
      }
    }
    const visibilityId = `vis-${characterId}-${declarationId}-${visOpts.validFrom}`;
    await this.store.nodes.Visibility.create({
      visibilityId,
      characterId,
      declarationId,
      state: visOpts.state,
      confidence: visOpts.confidence,
      source: visOpts.source,
      validFrom: visOpts.validFrom,
      validTo: INFINITY,
      isExplicit: visOpts.isExplicit,
    });
  }

  /**
   * 幂等可见性写入（C3 台账修复，2026-08-07）：同 setVisibility 签名；
   * 若 (characterId, declarationId) 已有未闭合 Visibility 则跳过（幂等返回，
   * 不抛错），否则走正常写入。供上层重试逻辑使用，避免重复记录。
   *
   * 注：第三参为可见性选项（沿 setVisibility 的 visOpts），第四参 strictOpts
   * 为 C4 严格模式（尾部参数名避让第三参，语义同其他方法的 opts.strict）。
   */
  async setVisibilityIfAbsent(
    characterId: string,
    declarationId: string,
    visOpts: {
      state: "known";
      confidence: number;
      source: VisibilitySource;
      validFrom: string;
      isExplicit: boolean;
    },
    strictOpts?: { strict?: boolean },
  ): Promise<void> {
    this.assertStoryTime(visOpts.validFrom);
    const existing = await this.store.nodes.Visibility.find({
      where: (v) => v.characterId.eq(characterId)
        .and(v.declarationId.eq(declarationId)).and(v.validTo.eq(INFINITY)),
    });
    if (existing.length > 0) return; // 幂等：已有未闭合记录则跳过
    await this.setVisibility(characterId, declarationId, visOpts, strictOpts);
  }

  async getVisibilityForCharacter(characterId: string, storyTime: string, opts?: TemporalQueryOpts): Promise<VisibilityDeclaration[]> {
    // B5：live 路径 where 下推（characterId 匹配），JS 过滤保留精确时态语义
    const all = await this.findNodes(
      "Visibility",
      opts?.recordedAsOf,
      (v) => v.characterId.eq(characterId),
    );
    return all
      .filter((v) => v.characterId === characterId
        && v.validFrom <= storyTime
        && (v.validTo === INFINITY || storyTime < v.validTo))
      .map((v) => ({
        characterId: v.characterId!,
        declarationId: v.declarationId!,
        state: v.state!,
        confidence: v.confidence!,
        source: v.source!,
        validFrom: v.validFrom,
        validTo: v.validTo,
        isExplicit: v.isExplicit!,
      })) as VisibilityDeclaration[];
  }

  /**
   * 闭合可见性声明：撤销某角色对某声明的可见性。
   * 找到匹配的未闭合记录（validTo === "Infinity"），闭合之。
   * 实现仿照 closeRelation。
   */
  async closeVisibility(characterId: string, declarationId: string, storyTime: string): Promise<void> {
    this.assertStoryTime(storyTime);
    // B5：where 谓词下推替代全表扫描
    const all = await this.store.nodes.Visibility.find({
      where: (v) => v.characterId.eq(characterId)
        .and(v.declarationId.eq(declarationId)).and(v.validTo.eq(INFINITY)),
    });
    const vis = all[0];
    if (!vis) {
      throw new Error(`Visibility ${characterId}->${declarationId} not found or already closed`);
    }
    await this.store.nodes.Visibility.update(vis.id, { validTo: storyTime });
  }

  /**
   * 反向可见性查询：某条声明被哪些角色可见。
   * 不传 storyTime 返回全部历史（含已闭合），传 storyTime 只返回该时刻有效的。
   * C2（2026-08-07）：支持 opts.recordedAsOf 做 retcon 隔离查询。
   */
  async getVisibilityForDeclaration(
    declarationId: string,
    storyTime?: string,
    opts?: TemporalQueryOpts,
  ): Promise<VisibilityDeclaration[]> {
    // B5：live 路径 where 下推（declarationId 匹配），JS 过滤保留精确时态语义
    const all = await this.findNodes(
      "Visibility",
      opts?.recordedAsOf,
      (v) => v.declarationId.eq(declarationId),
    );
    return all
      .filter((v) => v.declarationId === declarationId)
      .filter((v) => !storyTime
        || (v.validFrom <= storyTime && (v.validTo === INFINITY || storyTime < v.validTo)))
      .map((v) => ({
        characterId: v.characterId!,
        declarationId: v.declarationId!,
        state: v.state!,
        confidence: v.confidence!,
        source: v.source!,
        validFrom: v.validFrom,
        validTo: v.validTo,
        isExplicit: v.isExplicit!,
      })) as VisibilityDeclaration[];
  }

  async getAllDeclarationsAt(storyTime: string, opts?: TemporalQueryOpts): Promise<StateDeclaration[]> {
    const facts = await this.findNodes("Fact", opts?.recordedAsOf);
    return facts
      .filter((f) => f.validFrom <= storyTime
        && (f.validTo === INFINITY || storyTime < f.validTo))
      .map((f) => ({
        declarationId: f.declarationId!,
        entityId: f.entityId!,
        property: f.property!,
        description: f.description ?? "",
        modality: f.modality!,
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
      .map((f) => ({
        declarationId: f.declarationId!,
        entityId: f.entityId!,
        property: f.property!,
        description: f.description ?? "",
        modality: f.modality!,
        validFrom: f.validFrom,
        validTo: f.validTo,
      })) as StateDeclaration[];
  }

  async getAllRelationsAt(storyTime: string, opts?: TemporalQueryOpts): Promise<Array<{
    relationId: string; sourceId: string; targetId: string;
    label: string; description: string; validFrom: string; validTo: string;
  }>> {
    const rels = await this.findNodes("Relation", opts?.recordedAsOf);
    return rels
      .filter((r) => r.validFrom <= storyTime
        && (r.validTo === INFINITY || storyTime < r.validTo))
      .map((r) => ({
        relationId: r.relationId!,
        sourceId: r.sourceId!,
        targetId: r.targetId!,
        label: r.label!,
        description: r.description ?? "",
        validFrom: r.validFrom,
        validTo: r.validTo,
      }));
  }

  async inferVisibility(storyTime: string, opts?: TemporalQueryOpts): Promise<void> {
    const { inferVisibility: impl } = await import("./character-view.js");
    await impl(this, storyTime, opts);
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
    // B5（2026-08-07）：消除 N+1 —— 旧实现对每个实体调一次 getEntityAt，
    // 每次又 findNodes("Entity") + findNodes("Fact") 全扫（O(N²)）。
    // 改为 Entity/Fact 各取一次，内存分组组装；输出字段与 getEntityAt 完全一致
    // （含 opts.recordedAsOf 透传）。
    const entities = await this.findNodes("Entity", opts?.recordedAsOf);
    const facts = await this.findNodes("Fact", opts?.recordedAsOf);
    const factsByEntity = new Map<string, GraphRecord[]>();
    for (const f of facts) {
      const list = factsByEntity.get(f.entityId!) ?? [];
      list.push(f);
      factsByEntity.set(f.entityId!, list);
    }
    const snapshots: EntitySnapshot[] = [];
    for (const ent of entities) {
      if (!(ent.validFrom <= storyTime
        && (ent.validTo === INFINITY || storyTime < ent.validTo))) {
        continue;
      }
      const props = (factsByEntity.get(ent.entityId!) ?? [])
        .filter(
          (f) => f.validFrom <= storyTime
            && (f.validTo === INFINITY || storyTime < f.validTo),
        )
        .map(
          (f) =>
            ({
              declarationId: f.declarationId,
              entityId: f.entityId,
              property: f.property,
              description: f.description ?? "",
              modality: f.modality,
              validFrom: f.validFrom,
              validTo: f.validTo,
            }) as StateDeclaration,
        );
      snapshots.push({
        entityId: ent.entityId!,
        type: ent.type!,
        name: ent.name ?? "",
        aliases: ent.aliases ?? [],
        summary: ent.summary ?? "",
        validFrom: ent.validFrom,
        validTo: ent.validTo,
        properties: props,
      });
    }
    return snapshots;
  }

  /**
   * 历史查询：单个实体的全部版本（含已闭合记录），按 validFrom 升序。
   * 返回 Entity 记录数组 + 全部 Fact（含历史），供详情抽屉"历史"页签使用。
   * C2（2026-08-07）：支持 opts.recordedAsOf 做 retcon 隔离查询。
   */
  async getEntityHistory(entityId: string, opts?: TemporalQueryOpts): Promise<{
    entities: Array<{
      entityId: string;
      type: EntityType;
      name: string;
      aliases: string[];
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
    // B5：live 路径 where 下推（entityId 匹配），JS 过滤保留精确语义
    const entities = await this.findNodes(
      "Entity",
      opts?.recordedAsOf,
      (e) => e.entityId.eq(entityId),
    );
    const ents = entities
      .filter((e) => e.entityId === entityId)
      .map((e) => ({
        entityId: e.entityId!,
        type: e.type!,
        name: e.name ?? "",
        aliases: e.aliases ?? [],
        summary: e.summary ?? "",
        validFrom: e.validFrom,
        validTo: e.validTo,
      }))
      .sort((a, b) => a.validFrom.localeCompare(b.validFrom));

    const facts = await this.findNodes(
      "Fact",
      opts?.recordedAsOf,
      (f) => f.entityId.eq(entityId),
    );
    const allFacts = facts
      .filter((f) => f.entityId === entityId)
      .map((f) => ({
        declarationId: f.declarationId,
        entityId: f.entityId,
        property: f.property,
        description: f.description ?? "",
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
   * C2（2026-08-07）：支持 opts.recordedAsOf 做 retcon 隔离查询。
   */
  async getRelationHistory(entityId?: string, opts?: TemporalQueryOpts): Promise<Array<{
    relationId: string;
    sourceId: string;
    targetId: string;
    label: string;
    description: string;
    validFrom: string;
    validTo: string;
  }>> {
    // B5：live 路径 where 下推（entityId 提供时按 source/target 匹配），
    // JS 过滤保留精确语义
    const rels = await this.findNodes(
      "Relation",
      opts?.recordedAsOf,
      entityId
        ? (r) => r.sourceId.eq(entityId).or(r.targetId.eq(entityId))
        : undefined,
    );
    return rels
      .filter((r) => !entityId || r.sourceId === entityId || r.targetId === entityId)
      .map((r) => ({
        relationId: r.relationId!,
        sourceId: r.sourceId!,
        targetId: r.targetId!,
        label: r.label!,
        description: r.description ?? "",
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
      // SDK nodes 是 mapped type，动态 [nodeName] 访问需 as any（SDK 类型边界已知限制）
      const records = await (this.store.nodes as any)[nodeName].find() as GraphRecord[];
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
   * 经 asEmbedding helper 集中处理双重断言（运行时仍为 number[]）。
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
          embedding: asEmbedding(vec),
        });
      }
    }
    const facts = await this.store.nodes.Fact.find();
    for (const f of facts) {
      const decl: StateDeclaration = {
        declarationId: f.declarationId,
        entityId: f.entityId,
        property: f.property,
        description: f.description ?? "",
        modality: f.modality,
        validFrom: f.validFrom,
        validTo: f.validTo,
      };
      const vec = await embedder.embedFact(decl);
      await this.store.nodes.Fact.update(f.id, {
        embedding: asEmbedding(vec),
      });
    }
  }

  /**
   * 更新单条 Fact 的 embedding（P0-5 修复，2026-07-27）
   *
   * commit.ts 写扩散后增量更新向量，避免全量 reembedAll 的性能开销。
   * 找不到 declarationId 对应的 Fact 时不抛错（兼容导入器遗留数据）。
   *
   * B5（2026-08-07）：已用 where 谓词下推替代全表扫描（旧 TODO 的 P3 优化落地）。
   *
   * @param declarationId Fact 主键
   * @param embedding 512 维归一化向量
   */
  async updateFactEmbedding(declarationId: string, embedding: number[]): Promise<void> {
    // B5（2026-08-07）：where 谓词 SQL 下推替代 find() 全表扫描
    const facts = await this.store.nodes.Fact.find({
      where: (f) => f.declarationId.eq(declarationId),
    });
    // 不做类型断言，让 TS 推断 SDK 返回的 id 字段类型（NodeId branded type）
    const fact = facts[0];
    if (!fact) return; // 静默跳过（兼容性，不抛错）
    await this.store.nodes.Fact.update(fact.id, {
      embedding: asEmbedding(embedding),
    });
  }

  /**
   * 更新单条 Entity 的 embedding（P0-5 修复，备用 API）
   *
   * Entity.summary 变化时调用。D5（2026-08-07）：updateEntitySummary
   * 在配置了 embedder 时走此路径触发重嵌入。
   *
   * @param entityId 实体 ID（取 validTo=INFINITY 的当前版本）
   * @param embedding 512 维归一化向量
   */
  async updateEntityEmbedding(entityId: string, embedding: number[]): Promise<void> {
    // B5（2026-08-07）：where 谓词 SQL 下推替代 find() 全表扫描
    const entities = await this.store.nodes.Entity.find({
      where: (e) => e.entityId.eq(entityId).and(e.validTo.eq(INFINITY)),
    });
    // 不做类型断言，让 TS 推断 SDK 返回的 id 字段类型（NodeId branded type）
    const ent = entities[0];
    if (!ent) return; // 静默跳过（兼容性）
    await this.store.nodes.Entity.update(ent.id, {
      embedding: asEmbedding(embedding),
    });
  }
}
