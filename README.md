# underworld-graph

> Bi-temporal narrative state graph for fiction-writing engines.

Standalone narrative state management library. Stores entities, relations, facts,
events, and visibility declarations on a bi-temporal SQLite + TypeGraph backend.

Originally extracted from the `narrative-engine` monorepo as its core data asset,
now an independent package consumable by any narrative tool, visualizer, or importer.

## Features

- **Bi-temporal model**: every state declaration carries `validFrom`/`validTo`
  (story time) and `recordedAt` (transaction time, via SDK recorded instant)
- **Entity lifecycle**: birth / death with cascading fact closure
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
    { entityId: "ent-macbeth", property: "mood", value: "ambitious", modality: "fact" },
  ],
});

const snap = await wg.getEntityAt("ent-macbeth", "act1-scene4");
console.log(snap);

wg.close();
```

## API

### Factory

- `WorldGraph.create(opts): Promise<WorldGraph>` — async factory; initializes
  SQLite + sqlite-vec + TypeGraph store.
- `WorldGraph.migrate(opts): Promise<MigrateResult>` — migrate legacy db schema
  to current graph definition.

### Entity lifecycle

- `birthEntity(entityId, type, initialProps, storyTime, summary?)`
- `killEntity(entityId, storyTime)` — cascades to close open facts
- `getEntityAt(entityId, storyTime, opts?)` — bi-temporal snapshot
- `getAllEntities(storyTime, opts?)`
- `getEntityHistory(entityId)` — all versions incl. closed
- `updateEntitySummary(entityId, summary)`

### Relations

- `addRelation(sourceId, targetId, label, storyTime)`
- `closeRelation(sourceId, targetId, label, storyTime)`
- `getRelations(entityId, storyTime, opts?)`
- `getRelationHistory(entityId?)`

### Events

- `processEvent(input)` — append event + apply side effects (birth / death / change)
- `traceCauses(eventId)` — walk `causedBy` chain backwards
- `getAllEvents()`

### Visibility

- `setVisibility(characterId, declarationId, opts)`
- `closeVisibility(characterId, declarationId, storyTime)`
- `getVisibilityForCharacter(characterId, storyTime, opts?)`
- `getVisibilityForDeclaration(declarationId, storyTime?)`
- `inferVisibility(storyTime)` — auto-derive from `located_in` relations
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
