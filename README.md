# underworld-graph

> Bi-temporal narrative state graph for fiction-writing engines.

**Documentation**: https://uw.emaostudio.online/

Standalone narrative state management library. Stores entities, relations, facts,
events, and visibility declarations on a bi-temporal SQLite + TypeGraph backend.

Originally extracted from the `narrative-engine` monorepo as its core data asset,
now an independent package consumable by any narrative tool, visualizer, or importer.

## Features

- **Bi-temporal model**: every state declaration carries `validFrom`/`validTo`
  (story time) and `recordedAt` (transaction time, via SDK recorded instant)
- **Entity lifecycle**: birth / death with cascading fact + relation closure
- **Visibility tracking**: per-character knowledge with explicit / inferred sources
- **Event causality**: append-only JSONL event log with `causedBy` chain tracing
- **Full-text + vector search**: via `@nicia-ai/typegraph` + `sqlite-vec`

## Install

```bash
npm install underworld-graph
```

## Quick start

```typescript
import { WorldGraph } from "underworld-graph";

const wg = await WorldGraph.create({
  dbPath: "./world.db",
  eventLogPath: "./events.jsonl",
});

await wg.birthEntity("ent-macbeth", "character", { title: "Thane of Glamis" }, "act1-scene1");
await wg.processEvent({
  eventId: "evt-1",
  type: "change",
  storyTime: "act1-scene4",
  entityId: "ent-macbeth",
  invalidated: [],
  newFacts: [
    { entityId: "ent-macbeth", property: "mood", description: "ambitious", modality: "fact" },
  ],
});

const snap = await wg.getEntityAt("ent-macbeth", "act1-scene4");
console.log(snap);

wg.close();
```

## storyTime 约定

`storyTime` / `validFrom` / `validTo` 是纯字符串，时态查询按字典序比较
（`validFrom <= storyTime < validTo`）。请使用可字典序比较的格式（如
`act01-scene01` 零填充，或 ISO 8601），避免 `act1-scene10` 排在
`act1-scene2` 之前的问题。`INFINITY`（`"Infinity"`）表示未闭合，比较时须特判。

## API

### Factory

- `WorldGraph.create(opts): Promise<WorldGraph>` — async factory; initializes
  SQLite + sqlite-vec + TypeGraph store. `opts.storyTimePattern?: RegExp` 可启用
  storyTime 格式校验（推荐 `/^ch\d{3}\.ev\d{3}$/`）；`opts.embedder` 供
  updateEntitySummary 重嵌入。
- `WorldGraph.migrate(opts): Promise<MigrateResult>` — migrate TypeGraph schema
  version (e.g. after graph definition changes); accepts `WorldGraphOptions` or
  `{ dbPath }`; real legacy data migration is handled by the consumer's importer.

### Entity lifecycle

- `birthEntity(entityId, type, initialProps, storyTime, summary?, extraFacts?, opts?)`
  — `extraFacts` 逐条写 Fact（透传 entityId/modality，同 property 多条保留）；
  `opts.strict` 严格模式下实体已存活抛错
- `birthEntityUpsert(...)` — 同 birthEntity 签名；实体已存活则幂等跳过
- `killEntity(entityId, storyTime)` — cascades to close open facts and relations
- `getEntityAt(entityId, storyTime, opts?)` — bi-temporal snapshot
- `getAllEntities(storyTime, opts?)`
- `getEntityHistory(entityId, opts?)` — all versions incl. closed
- `updateEntitySummary(entityId, summary, storyTime)` — 覆盖 summary + 写 change
  事件（可回溯）；配置 `embedder` 时触发重嵌入

### Relations

- `addRelation(sourceId, targetId, label, storyTime, opts?)` — `opts.strict` 校验两端实体存活
- `closeRelation(sourceId, targetId, label, storyTime)`
- `getRelations(entityId, storyTime, opts?)`
- `getRelationHistory(entityId?, opts?)`

### Events

- `processEvent(input)` — append event + apply side effects (birth / death / change)；
  `input.strict` 严格模式校验引用完整性（不落日志）
- `traceCauses(eventId): Promise<EventRecord[] | null>` — walk `causedBy` chain
  backwards；eventId 不存在返回 `null`，前驱丢失抛错
- `getAllEvents()`

### Visibility

- `setVisibility(characterId, declarationId, visOpts, strictOpts?)`
- `setVisibilityIfAbsent(...)` — 同 setVisibility 签名；已有未闭合记录则幂等跳过
- `closeVisibility(characterId, declarationId, storyTime)`
- `getVisibilityForCharacter(characterId, storyTime, opts?)`
- `getVisibilityForDeclaration(declarationId, storyTime?, opts?)`
- `inferVisibility(storyTime, opts?)` — auto-derive from `located_in` relations
- `getCharacterView(characterId, storyTime, opts?)` — declarations visible to a character

### Declarations

- `getAllDeclarationsAt(storyTime, opts?)` — valid at story time
- `getAllDeclarations(opts?)` — all incl. closed (knowledge persistence)

### Search & query

- `wg.search` — passthrough TypeGraph `StoreSearch` (fulltext / vector / hybrid)
- `wg.query()` — TypeGraph `QueryBuilder` entry
- `wg.recordedNow()` — current transaction instant
- `reembedAll(embedder)`, `updateFactEmbedding(id, vec)`, `updateEntityEmbedding(id, vec)`

### Utilities

- `listStoryTimes()` — all distinct story time points
- `close()` — release db handle

## Architecture

- **Storage**: SQLite (via `better-sqlite3`) + `sqlite-vec` for vector index
- **Graph SDK**: `@nicia-ai/typegraph` provides bi-temporal node/edge store with
  schema migration, full-text search (zh), and vector search
- **ORM**: `drizzle-orm` for SQLite backend
- **Validation**: `zod` schemas for all public types

The graph defines four node types: `Entity`, `Fact`, `Relation`, `Visibility`,
with `validFrom` / `validTo` schema fields managed by this library to encode
bi-temporal semantics on top of TypeGraph's transaction-time history.

## License

GPL-3.0-only
