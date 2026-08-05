# underworld-graph 部署与源码指南

> 版本：`0.1.2`　·　协议：GPL-3.0-only　·　作者：lmy414　·　npm 包名：`underworld-graph`
>
> 如果你对这个项目感兴趣，可以看看下面的内容，欢迎提出修改建议，我会认真采纳。

## 目录

1. [包定位与架构概览](#1-包定位与架构概览)
2. [服务器部署完整流程](#2-服务器部署完整流程)
3. [依赖与运行时要求](#3-依赖与运行时要求)
4. [目录结构](#4-目录结构)
5. [逐文件源码解析](#5-逐文件源码解析)
   - 5.1 [`package.json`](#51-packagejson)
   - 5.2 [`tsconfig.json`](#52-tsconfigjson)
   - 5.3 [`.gitignore`](#53-gitignore)
   - 5.4 [`src/index.ts` — 公共导出清单](#54-srcindexts--公共导出清单)
   - 5.5 [`src/types.ts` — Zod schema 与类型常量](#55-srctypepests--zod-schema-与类型常量)
   - 5.6 [`src/event-log.ts` — JSONL 事件日志](#56-srcevent-logts--jsonl-事件日志)
   - 5.7 [`src/character-view.ts` — 角色视角与可见性推断](#57-srccharacter-viewts--角色视角与可见性推断)
   - 5.8 [`src/world-graph.ts` — 核心图引擎](#58-srcworld-graphts--核心图引擎)
   - 5.9 [`scripts/smoke.mjs` — 端到端冒烟](#59-scriptssmokemjs--端到端冒烟)
   - 5.10 [`.github/workflows/ci.yml` — CI 流水线](#510-githubworkflowsciyml--ci-流水线)
6. [API 速查表](#6-api-速查表)
7. [数据模型与存储布局](#7-数据模型与存储布局)
8. [运维与备份](#8-运维与备份)
9. [已知问题与后续路线](#9-已知问题与后续路线)

---

## 1. 包定位与架构概览

`underworld-graph` 是一个**双时态叙事状态图库**（bi-temporal narrative state graph），
为虚构创作引擎提供数据底座。三个关键能力：

- **双时态**：每条状态声明都携带 `validFrom` / `validTo`（故事时间轴）和 `recordedAt`
  （事务时间轴），可查询"故事时刻 X 时的世界状态，但只含墙钟 Y 之前写入的内容"
  （retcon 隔离）。
- **事件溯源**：所有写入走 `processEvent`，先 append JSONL 日志（含 `causedBy` 因果链），
  再扩散到状态图，可沿因果链回溯任何变更的起源。
- **可见性追踪**：每个角色对每条声明独立持有可见性记录，区分"自产自知 / 他人告知 /
  基础设施推断"三种来源，支持"角色 A 知道什么"的查询。

技术栈分层：

```
┌─────────────────────────────────────────────────┐
│ 消费方（narrative-engine / visualizer / 导入器）│
├─────────────────────────────────────────────────┤
│        underworld-graph（本包，纯库）            │
│  WorldGraph / EventLog / characterView          │
├─────────────────────────────────────────────────┤
│  @nicia-ai/typegraph（双时态图 SDK）            │
│  HistoryStore + searchable/embedding 字段        │
├─────────────────────────────────────────────────┤
│  drizzle-orm（SQLite ORM 适配层）               │
├─────────────────────────────────────────────────┤
│  better-sqlite3 + sqlite-vec（原生 SQLite + 向量扩展）│
├─────────────────────────────────────────────────┤
│  SQLite 数据库文件（world.db + events.jsonl）   │
└─────────────────────────────────────────────────┘
```

**重要：本包是纯库，不是服务。** 它不监听端口、不暴露 HTTP，只导出一个 Node.js
ESM 模块。消费方负责文件路径管理、HTTP 层、并发调度。服务器部署本质上是
"装 Node + 装依赖 + 让你的服务进程引用本包"。

---

## 2. 服务器部署完整流程

### 2.1 环境准备

```bash
# 1. Node.js >= 20（强烈建议 22 LTS）
node --version    # 应输出 v20.x 或 v22.x

# 2. Python 3 + 构建工具（better-sqlite3 是原生模块，需 node-gyp 编译）
#    Linux 服务器：
sudo apt-get install -y python3 make g++
#    macOS（开发机）：
# xcode-select --install

# 3. npm（随 Node 自带）
npm --version
```

### 2.2 选择部署形态

| 形态 | 适用场景 | 关键步骤 |
|---|---|---|
| **A. 作为依赖集成到你的服务** | 生产推荐 | 你的服务 `package.json` 加 `"underworld-graph": "0.1.2"`，自己的进程管 SQLite 文件路径 |
| **B. 从源码克隆自部署** | 调试 / 二次开发 | `git clone` + `npm install` + `npm run build`，再被你的服务以 file: 引用 |
| **C. 纯 npm 安装验证** | 试用 | `npm install underworld-graph` 后写脚本调用 |

### 2.3 形态 A：作为依赖集成到你的服务（推荐）

在你的服务目录：

```bash
cd /opt/your-service
npm install underworld-graph@0.1.2
# 此时 better-sqlite3 + sqlite-vec 会被自动编译
```

你的服务代码：

```typescript
// your-service/src/world.ts
import { WorldGraph } from "underworld-graph";
import path from "node:path";

const DATA_DIR = process.env.WG_DATA_DIR ?? "/var/lib/your-service/world";

export const wg = await WorldGraph.create({
  dbPath: path.join(DATA_DIR, "world.db"),
  eventLogPath: path.join(DATA_DIR, "events.jsonl"),
});

// 优雅关闭：进程退出时释放 SQLite 句柄
process.on("SIGTERM", () => {
  wg.close();
  process.exit(0);
});
```

目录权限：

```bash
sudo mkdir -p /var/lib/your-service/world
sudo chown -R your-service:your-service /var/lib/your-service/world
```

### 2.4 形态 B：从源码克隆自部署

```bash
# 1. 克隆
git clone git@github.com:lmy414/underworld-graph.git
cd underworld-graph
git checkout v0.1.2   # 或 master

# 2. 装依赖（会编译 better-sqlite3 原生模块）
npm install

# 3. 构建（tsc 编译 src/ → dist/）
npm run build

# 4. 跑测试验证环境（59 个用例，约 10 秒）
npm test

# 5. 你的服务以 file: 引用
cd /opt/your-service
npm install /path/to/underworld-graph
```

### 2.5 systemd 服务单元示例

`/etc/systemd/system/your-service.service`：

```ini
[Unit]
Description=Your Narrative Service (uses underworld-graph)
After=network.target

[Service]
Type=simple
User=your-service
WorkingDirectory=/opt/your-service
Environment=NODE_ENV=production
Environment=WG_DATA_DIR=/var/lib/your-service/world
ExecStart=/usr/bin/node dist/main.js
Restart=on-failure
RestartSec=5
# 关键：SQLite 单写者，不要起多实例指向同一 db 文件
# 若要多进程，每个进程用独立 dbPath

[Install]
WantedBy=multi-user.target
```

启用：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now your-service
sudo journalctl -u your-service -f
```

### 2.6 反向代理（可选）

本包不暴露 HTTP。若你的服务用 Express/Fastify：

```nginx
server {
  listen 443 ssl http2;
  server_name narrative.example.com;

  ssl_certificate     /etc/letsencrypt/live/narrative.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/narrative.example.com/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:7421;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout 300s;   # LLM 调用可能慢
  }
}
```

### 2.7 部署后冒烟验证

```bash
# 1. 进程存活
systemctl status your-service

# 2. db 文件已创建
ls -la /var/lib/your-service/world/
# 应看到 world.db, world.db-wal, world.db-shm, events.jsonl

# 3. 调用你的服务的健康检查端点（如有）
curl http://127.0.0.1:7421/health

# 4. 跑包自带的冒烟脚本（仅形态 B 可用）
cd /path/to/underworld-graph
npm run smoke
# 预期输出结尾："✅ 端到端冒烟全部通过"
```

---

## 3. 依赖与运行时要求

### 3.1 运行时依赖（`dependencies`）

| 包 | 版本约束 | 用途 | 备注 |
|---|---|---|---|
| `@nicia-ai/typegraph` | `~0.40.0` | 双时态图 SDK，提供 HistoryStore / searchable / embedding / schema migration | 锁 minor 允许 patch；SDK 内部依赖 drizzle |
| `better-sqlite3` | `^11.0.0` | 同步 SQLite 原生绑定 | **需 node-gyp 编译**，部署机要有 Python 3 + C++ 编译器 |
| `drizzle-orm` | `^0.36.0` | SQLite ORM 适配层 | typegraph SDK 通过它对接 better-sqlite3 |
| `sqlite-vec` | `^0.1.9` | SQLite 向量扩展 | 提供向量索引与相似度检索，运行时 `load` 进 db 连接 |
| `zod` | `^4.0.0` | 运行时 schema 校验 | 所有公共类型都先用 zod 定义再 infer 出 TS 类型 |

### 3.2 开发依赖（`devDependencies`）

| 包 | 版本 | 用途 |
|---|---|---|
| `@types/better-sqlite3` | `^7.6.0` | better-sqlite3 的 TypeScript 类型 |
| `tsx` | `^4.0.0` | 直接跑 .ts 测试，无需预编译 |
| `typescript` | `^5.5.0` | tsc 编译 + 类型检查 |

### 3.3 引擎约束

```json
"engines": { "node": ">=20" }
```

Node 20 是硬下限（CI 在 20 和 22 上跑）。低于 20 不保证。

### 3.4 原生模块编译注意

`better-sqlite3` 是 C++ 原生模块。三种安装路径：

1. **预编译二进制**（最常见）：npm 装包时下载预编译的 `.node` 文件，秒装。
2. **源码编译**：预编译二进制不可用时（如 musl libc 的 Alpine），fallback 到
   `node-gyp` 编译，需要 Python 3 + make + C++。
3. **Docker 部署**：基于 Alpine 镜像时建议换 debian-slim，或显式装
   `python3 make g++`。

Dockerfile 片段（debian-slim 基底）：

```dockerfile
FROM node:22-slim
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
USER node
CMD ["node", "dist/main.js"]
```

---

## 4. 目录结构

```
underworld-graph/
├── .github/
│   └── workflows/
│       └── ci.yml              # GitHub Actions：test (Node 20/22) + publish (tag 触发)
├── docs/
│   ├── design-review-2026-08-02.md   # 设计评审存档（14 项问题清单）
│   └── DEPLOYMENT.md           # 本文档
├── scripts/
│   └── smoke.mjs               # 端到端冒烟脚本（Macbeth 故事片段）
├── src/                        # 源码（编译单元 rootDir）
│   ├── index.ts                # 公共导出清单
│   ├── types.ts                # zod schema + 类型常量
│   ├── event-log.ts            # JSONL 事件日志
│   ├── character-view.ts       # 角色视角 + 可见性推断
│   └── world-graph.ts          # 核心引擎（最大文件，1030 行）
├── tests/                      # 12 个测试文件，59 个用例
│   ├── api.test.ts             # 公共 API 暴露面
│   ├── character-view.test.ts  # 角色视角
│   ├── entities.test.ts        # 实体生命周期
│   ├── events.test.ts          # 事件日志 + 因果链
│   ├── index.test.ts           # 导出清单
│   ├── migrate.test.ts         # schema 迁移
│   ├── query.test.ts           # 双时态查询
│   ├── schema.test.ts          # zod schema 校验
│   ├── search.test.ts          # 全文 / 向量 / 混合检索
│   ├── temporal.test.ts        # recordedAsOf retcon 隔离
│   ├── types.test.ts           # 枚举类型校验
│   └── visibility.test.ts      # 可见性声明
├── .gitignore
├── CHANGELOG.md
├── LICENSE                     # GPL-3.0-only
├── README.md
├── package.json
├── package-lock.json
└── tsconfig.json
```

**构建产物**：`npm run build` 后生成 `dist/`，结构与 `src/` 一致但扩展名为
`.js` + `.d.ts`。`.gitignore` 排除 `dist/`，不在仓库内提交。

---

## 5. 逐文件源码解析

> 解读约定：每个文件先给"职责一句话"，再按 token 顺序逐段拆。引用源码用行号锚定。

### 5.1 `package.json`

**职责**：npm 包元数据 + 脚本入口 + 依赖锁定。

逐字段：

- `name`: `"underworld-graph"` — npm 包名（无 scope，公开包）。
- `version`: `"0.1.2"` — 当前发布版本。
- `description`: `"Bi-temporal narrative state graph for fiction-writing engines."`
  — 一句话定位。
- `keywords`: 8 个发现关键词：`narrative / story / graph / bi-temporal / sqlite /
  knowledge-graph / fiction / worldbuilding`。
- `license`: `"GPL-3.0-only"` — 强 copyleft，下游使用需注意传染性。
- `author`: `"lmy414"`。
- `repository.url`: `"git+https://github.com/lmy414/underworld-graph.git"` —
  GitHub 仓库地址（注意：实际 push 时可能改用 SSH，见部署章节）。
- `private`: `false` — 公开发布。
- `type`: `"module"` — **ESM 模块系统**，所有 `.js` 文件按 ES module 处理。
- `main`: `"./dist/index.js"` — CommonJS 入口（虽是 ESM 但保留 main 兼容旧解析器）。
- `types`: `"./dist/index.d.ts"` — TS 类型入口。
- `exports`：现代模块解析入口，优先 `types` 再 `import`，只暴露 `.`（根导出），
  不暴露子路径，强制消费方走公共 API。
- `scripts`：
  - `build`: `tsc` — 编译 `src/` → `dist/`。
  - `test`: `tsx --test tests/*.test.ts` — 用 Node 内置 test runner，tsx 直跑 .ts。
  - `typecheck`: `tsc --noEmit` — 仅类型检查，不产出。
  - `smoke`: `tsx scripts/smoke.mjs` — 跑端到端冒烟。
  - `prepare`: `npm run build` — npm install 后自动编译（含 npm publish 时）。
  - `prepublishOnly`: `npm run build && npm test` — 发布前强制跑 build + 测试，
    失败则阻止发布。
- `files`: `["dist/", "src/", "README.md", "CHANGELOG.md", "LICENSE"]` —
  发布到 npm 的文件白名单。注意 `src/` 也被打包，方便消费方读源码调试。
- `dependencies` / `devDependencies`：见 [§3](#3-依赖与运行时要求)。
- `engines.node`: `">=20"` — 硬约束。

### 5.2 `tsconfig.json`

**职责**：TypeScript 编译配置。

逐选项：

- `target`: `"ES2022"` — 输出 JS 语法目标，支持顶层 await、class fields 等。
- `module`: `"ESNext"` — 输出 ESM 模块格式。
- `moduleResolution`: `"bundler"` — 模块解析策略，匹配现代打包器/Node ESM。
- `outDir`: `"./dist"` — 编译产物目录。
- `rootDir`: `"./src"` — 源码根目录，限制编译范围。
- `strict`: `true` — 全量严格模式（noImplicitAny / strictNullChecks 等）。
- `esModuleInterop`: `true` — 允许默认导入 CommonJS 模块。
- `skipLibCheck`: `true` — 跳过 .d.ts 文件类型检查（加速编译）。
- `forceConsistentCasingInFileNames`: `true` — 强制文件名大小写一致（跨平台）。
- `declaration`: `true` — 生成 `.d.ts`。
- `emitDeclarationOnly`: `false` — 同时生成 `.js` 和 `.d.ts`。
- `allowImportingTsExtensions`: `false` — 不允许 `.ts` 扩展名 import，
  故源码里写 `.js` 后缀（ESM 约定）。
- `declarationMap` / `sourceMap`: `false` — 不生成 source map（产物精简）。
- `resolveJsonModule`: `true` — 允许 import JSON。
- `isolatedModules`: `true` — 每个文件独立编译（匹配 tsx / esbuild 行为）。
- `verbatimModuleSyntax`: `false` — 不强制 type-only import 显式标记。
- `include`: `["src/**/*"]` — 编译单元只含 src/。
- `exclude`: `["tests", "scripts", "dist", "node_modules"]` — 排除测试和产物。

### 5.3 `.gitignore`

**职责**：排除不应进 git 的文件。

```
data/           # 本地试验数据
dist/           # 编译产物
node_modules/   # 依赖
*.db            # SQLite 数据库文件
*.db-wal       # SQLite WAL 日志
*.db-shm       # SQLite 共享内存
*.tsbuildinfo  # tsc 增量编译缓存
```

关键点：**db 文件不进 git**。部署时由运行时创建，备份策略另定（见 [§8](#8-运维与备份)）。

### 5.4 `src/index.ts` — 公共导出清单

**职责**：包的对外门面，决定哪些符号是稳定公共 API、哪些是内部试探性导出。

源码逐段：

```typescript
// 行 1-7：注释说明软隔离约定
// 公共 API 出口（飞书文档"四、模块导出清单"）
// 内部实现文件（world-graph.ts/event-log.ts/character-view.ts）不直接导出
//
// 软隔离约定（2026-07-29）：
// - 无前缀导出 = 公共 API，其他子包与扩展层可直接引用
// - _ 前缀导出 = 包内部实现，不保证稳定，外部不应依赖
```

设计意图：消费方**只能 `import { ... } from "underworld-graph"`**，不能直接
`import { EventLog } from "underworld-graph/event-log"`（`exports` 字段不暴露子路径）。
内部文件不直接被外部引用，方便重构。

```typescript
// 行 11-12：公共类与类型
export { WorldGraph } from "./world-graph.js";
export type { EntitySnapshot, MigrateResult } from "./world-graph.js";
```

`WorldGraph` 是值导出（类），`EntitySnapshot` / `MigrateResult` 是类型导出
（`export type` 避免运行时副作用）。

```typescript
// 行 16-23：Zod schema 同时导出值和类型
export {
  EntityType,
  Modality,
  EventType,
  StateDeclaration,
  EventRecord,
} from "./types.js";
export type { EventRecordInput } from "./types.js";
```

注释解释：`export { X }` 已同时导出值（运行时 `.parse()`）和类型，无需再
`export type { X }`，否则 TS2300 重复标识符。`EventRecordInput` 只导出类型
（它是 `z.input<>`，仅供 TS 编译期使用）。

```typescript
// 行 29-37：内部导出（_ 前缀）
export {
  EventSource as _EventSource,
  VisibilityDeclaration as _VisibilityDeclaration,
  INFRA_RELATIONS as _INFRA_RELATIONS,
} from "./types.js";
export type {
  WorldGraphOptions as _WorldGraphOptions,
  TemporalQueryOpts as _TemporalQueryOpts,
} from "./world-graph.js";
```

`_` 前缀 = 软隔离，告诉消费方"可用但不保证稳定"。测试和调试场景会用，
生产代码不应依赖。

### 5.5 `src/types.ts` — Zod schema 与类型常量

**职责**：定义所有领域类型的 zod schema，运行时校验 + 编译期类型推导的双重保证。

#### 实体类型枚举（行 10-11）

```typescript
export const EntityType = z.enum(["character", "location", "item", "concept"]);
export type EntityType = z.infer<typeof EntityType>;
```

4 类几何定义：
- `character` 有意志的实体（角色）
- `location` 被动空间实体（场景）
- `item` 物品实体
- `concept` 弥漫性概念实体（世界观、规则、组织）

`z.enum` 既是值（运行时校验）也是类型（`z.infer` 推导出联合类型）。

#### 模态系统（行 19-20）

```typescript
export const Modality = z.enum(["fact", "belief", "hypothesis"]);
```

声明的认识论地位：
- `fact` 客观事实
- `belief` 角色信念（主观）
- `hypothesis` 假设/推测

用于 characterView 的 `modalityFilter`，例如只看客观事实时传 `["fact"]`。

#### 事件类型（行 28-29）

```typescript
export const EventType = z.enum(["birth", "death", "change"]);
```

3 类原子操作。`processEvent` 按此分派。

#### 状态声明（行 36-46）

```typescript
export const StateDeclaration = z.object({
  declarationId: z.string(),
  entityId: z.string(),
  property: z.string(),
  value: z.unknown(),
  valueText: z.string().optional(),
  modality: Modality,
  validFrom: z.string(),
  validTo: z.string(),
});
```

TypeGraph 中状态的最小单元。关键字段：

- `declarationId` 全局唯一，格式约定 `decl-{entityId}-{property}-{storyTime}`。
- `value: z.unknown()` — 不约束值类型（任何 JSON 可序列化值都行）。
- `valueText` 可选，是 value 的字符串化版本，参与全文检索（zh 分词）。
- `validFrom` / `validTo` 时态区间，`validTo = "Infinity"` 表示未闭合。

#### 事件来源与事件记录（行 55-93）

```typescript
export const EventSource = z.enum(["engine", "user"]);
```

- `engine` 引擎扩散产生（如 commit 写扩散）
- `user` 用户/前端编辑产生

```typescript
export const EventRecord = z.object({
  eventId: z.string(),
  type: EventType,
  storyTime: z.string(),
  entityId: z.string(),
  source: EventSource.default("engine"),
  entityType: EntityType.optional(),
  summary: z.string().optional(),
  invalidated: z.array(...).optional(),
  newFacts: z.array(...).optional(),
  causedBy: z.string().optional(),
  userInput: z.string().optional(),
  recordedAt: z.string().optional(),
});
```

逐字段：

- `eventId` 全局唯一，由调用方生成（建议 UUID 或时间戳+随机）。
- `storyTime` 故事时间标识（如 `"act1-scene4"`），字符串字典序可比较。
- `source` 缺省 `"engine"`。
- `entityType` 仅 birth 事件用，缺省时 `processEvent` 默认 `"character"`。
- `summary` 仅 birth 事件用，实体的无状态客观事实描述。
- `invalidated` 仅 change 事件用，列出要闭合的旧声明。
- `newFacts` birth / change 事件用，新声明数组。
- `causedBy` 指向前驱事件的 `eventId`，组成因果链。
- `userInput` 用户口述原文（2026-07-25 新增），跨会话项目记忆引用。
- `recordedAt` 写入墙钟时间（2026-07-25 新增），双时态事务时间轴。

```typescript
export type EventRecordInput = z.input<typeof EventRecord>;
```

`z.input` 推导出"输入侧"类型：`source` 可省略（因为 `.default()`），其他 optional
字段仍 optional。这是 `processEvent` 接受的入参类型。

#### 可见性来源（行 104-105）

```typescript
export const VisibilitySource = z.enum(["experienced", "informed", "witnessed"]);
```

- `experienced` 自产自知（角色自己产出的 state_change，confidence=1）
- `informed` 他人告知（角色通过对话/观察学到的他人状态）
- `witnessed` 基础设施推断（`inferVisibility` 自动为 `located_in` 关系推导）

2026-07-29 从 `z.string()` 收窄为枚举，清理历史遗留值 `self/rumor/told/explicit/inferred`。
旧数据保持原样不迁移。

#### 可见性声明（行 110-120）

```typescript
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
```

注意 `state` 当前只有 `"known"` 一个值（设计冗余，未来扩展 `forgotten` / `suspected`）。

#### 基础设施关系常量（行 127）

```typescript
export const INFRA_RELATIONS: readonly string[] = ["located_in"] as const;
```

`inferVisibility` 会遍历所有 `label === "located_in"` 的关系做同地点可见性推断。

#### INFINITY 哨兵（行 136）

```typescript
export const INFINITY = "Infinity";
```

未闭合标记。**关键陷阱**：字符串字典序 `"I" < "a"`，所以所有时态比较
`validFrom <= t < validTo` 必须先特判 `validTo === INFINITY`，否则会误判未闭合记录。
全包所有时态过滤都遵守此约定。

### 5.6 `src/event-log.ts` — JSONL 事件日志

**职责**：append-only JSONL 事件日志，每行一个 EventRecord JSON，支持因果链回溯。

```typescript
import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { EventRecord } from "./types.js";
import type { EventRecordInput } from "./types.js";
```

同步 fs API（`appendFileSync` / `readFileSync`）。设计选择：写日志是写扩散的第一步，
同步写入确保日志落盘后才继续状态图写入，崩溃时日志优先保留。

```typescript
export class EventLog {
  constructor(private readonly path: string) {}
```

构造函数只存路径，不打开文件句柄。每次 append/read 都直接操作路径，
所以 `close()` 是 no-op。

```typescript
  async append(input: EventRecordInput): Promise<void> {
    const line = JSON.stringify(EventRecord.parse(input)) + "\n";
    appendFileSync(this.path, line, "utf-8");
  }
```

`EventRecord.parse` 应用默认值（`source` 缺省 `"engine"`），日志行始终是完整
EventRecord。`+ "\n"` 保证每行一个 JSON。

**已修复（0.1.2）**：单行损坏不再影响整体 —— `readAll` 逐行 try/catch +
`EventRecord.safeParse`，语法损坏与形状不符（合法 JSON 但缺字段/类型错）的行均跳过
（记 stderr），剩余行正常读出。

```typescript
  async readAll(): Promise<EventRecord[]> {
    if (!existsSync(this.path)) return [];
    const content = readFileSync(this.path, "utf-8");
    return content
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as EventRecord);
  }
```

文件不存在返回空数组。读全文 split 行，过滤空行，逐行 `JSON.parse`。

**已知问题（未修复）**：全文读取 + 全建 Map，日志上规模后内存与时间开销显著。
流式读取属性能优化项，与 §9.2 的 B5 同批排期。

```typescript
  async traceBack(eventId: string): Promise<EventRecord[]> {
    const all = await this.readAll();
    const byId = new Map(all.map((e) => [e.eventId, e]));
    const chain: EventRecord[] = [];
    let cur = byId.get(eventId);
    while (cur) {
      chain.unshift(cur);
      const causedBy = cur.causedBy;
      cur = causedBy ? byId.get(causedBy) : undefined;
    }
    return chain;
  }
```

沿 `causedBy` 字段回溯因果链。`chain.unshift` 保证返回顺序是从最早的祖先到当前事件。

**已知问题**：`causedBy` 指向不存在的事件时静默停止（不区分"无前驱"和"前驱不存在"）。

```typescript
  close(): void {
    // 当前实现无状态，无需释放
  }
```

no-op `close()`。0.1.1 新增，与 `WorldGraph.close()` 资源语义对称。未来若改用文件流，
此处释放对应资源。

### 5.7 `src/character-view.ts` — 角色视角与可见性推断

**职责**：实现飞书文档"步骤 5"的 characterView 五步过滤，和"步骤 6"的
`inferVisibility` 基础设施关系推断。

```typescript
import type { WorldGraph } from "./world-graph.js";
import type { VisibilityDeclaration, StateDeclaration, Modality } from "./types.js";
```

只 import type（编译期），运行时无副作用，避免循环依赖。

#### `characterView` 函数（行 17-42）

五步过滤（2026-07-22 语义修订：知识持续）：

1. 查全部 StateDeclaration（含已闭合——知识不因声明闭合/实体死亡而消失）。
2. 查 characterId 在 storyTime 时刻持有的 VisibilityDeclaration。
3. 有效起点 = `max(visibility.validFrom, declaration.validFrom)`（不能先于声明存在而知晓）。
4. 有效终点 = `visibility.validTo`（不再与 `declaration.validTo` 取交：知识一旦获得就持续持有，
   直到可见性被显式撤销）。
5. 过滤 `state === "known" && start <= storyTime && modalityFilter 命中`。

```typescript
export async function characterView(
  wg: WorldGraph,
  characterId: string,
  storyTime: string,
  opts: { modalityFilter?: Modality[]; recordedAsOf?: string } = {},
): Promise<StateDeclaration[]> {
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
```

`recordedAsOf` 透传到两层查询，实现 retcon 隔离：声明与可见性记录都重建到该写入时点，
之后补写/改写的内容不可见。

#### `inferVisibility` 函数（行 50-67）

```typescript
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
        isExplicit: false,
        validFrom,
      });
    }
  }
}
```

遍历 storyTime 时刻所有 `located_in` 关系，对每条关系把 target 实体的所有有效声明
标记为 source 角色可见。`validFrom` 取角色进入时间和声明时间中较晚者。

**已修复（0.1.2）**：inferVisibility 幂等 —— 写入前做全历史判定（含已闭合记录），
当前可见则跳过；存在 `validTo <= storyTime` 的撤销记录时，新可见性 validFrom 取当前
推断时刻，不回填到撤销区间之前（含回归测试）。

### 5.8 `src/world-graph.ts` — 核心图引擎

**职责**：本包最大文件（1030 行），定义 TypeGraph schema、`WorldGraph` 类、所有公共 API
实现。逐段拆解。

#### Imports（行 1-22）

```typescript
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
import { EntityType, Modality, EventRecord, VisibilitySource, INFINITY } from "./types.js";
import type { StateDeclaration, VisibilityDeclaration, EventRecordInput } from "./types.js";
import { EventLog } from "./event-log.js";
```

- `better-sqlite3` 同步 SQLite 绑定。
- `drizzle-orm/better-sqlite3` SQLite ORM 适配。
- `sqlite-vec` 向量扩展，`load` 进 db 连接。
- `@nicia-ai/typegraph` 核心 SDK：`createStoreWithSchema` / `defineNode` / `defineEdge`
  / `defineGraph` / `searchable` / `embedding` / `sqliteVecStrategy`。
- `type { HistoryStore, EmbeddingValue, RecordedInstant }` — 仅类型导入。
- `createSqliteBackend` / `generateSqliteMigrationSQL` — drizzle SQLite 适配。
- `getActiveSchema` / `migrateSchema` — schema 版本管理。
- `zod` schema 校验。
- 本包内部：types.js 的值与类型，event-log.js 的 EventLog 类。

#### `asEmbedding` helper（行 25-33）

```typescript
function asEmbedding(vec: number[]): EmbeddingValue {
  return vec as unknown as EmbeddingValue;
}
```

把 `number[]` 断言为 SDK 的 `EmbeddingValue` branded type。SDK 的
`EmbeddingValue = readonly number[] & { [EMBEDDING_BRAND]: true }`，是编译期 brand，
运行时仍是 `number[]`。集中到此 helper，避免散落的 `as unknown as`。0.1.1 新增。

#### `GraphRecord` 接口（行 43-72）

```typescript
interface GraphRecord {
  id: string;
  entityId?: string;
  type?: EntityType;
  // ... 各节点类型字段并集 ...
  validFrom: string;
  validTo: string;
  embedding?: EmbeddingValue;
  meta?: { createdAt?: string; updatedAt?: string };
}
```

内部节点记录类型 — SDK 节点 find/scan 返回值的并集。SDK 的节点类型是 branded NodeId
+ mapped type，动态访问 `(this.store.nodes as any)[kind]` 无法保留精确类型，故定义此
宽松接口。各字段 optional（不同节点类型字段不同），调用方按需读取。0.1.1 新增，替代了
30+ 处 `(x: any)`。

#### TypeGraph 节点定义（行 79-127）

```typescript
const EntityNode = defineNode("Entity", {
  schema: z.object({
    entityId: z.string(),
    type: EntityType,
    summary: z.string().default(""),
    validFrom: z.string(),
    validTo: z.string(),
    embedding: embedding(512).optional(),
  }),
});
```

4 个节点类型：

- `EntityNode` — 实体。`embedding(512)` 512 维向量字段（用于相似度检索）。
  `summary` 默认空串，是实体无状态客观事实描述。
- `FactNode` — 状态声明。`property` 和 `valueText` 用 `searchable({ language: "zh" })`
  包装，启用中文全文检索。
- `RelationNode` — 关系三元组（source / target / label）。
- `VisibilityNode` — 可见性声明。

`validFrom` / `validTo` 作为 schema 字段，由应用层管理 bi-temporal 语义。
`"Infinity"` 表示未闭合。

#### `declaresEdge` 预留定义（行 138）

```typescript
const declaresEdge = defineEdge("declares");
```

行 129-137 的注释说明：`declares` 边（Entity → Fact）预留定义，**当前未使用**。
`birthEntity` / `processEvent` 写 Fact 时不创建 declares 边，查询也不走边遍历。
保留是为了未来知识图谱遍历需求。

**关键**：删除此边定义会改变 graph schema_hash，触发旧库 `MIGRATION_ERROR`，
故即使未用也不要删除。

#### Graph 定义（行 140-151）

```typescript
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
```

graph id 是 `"world"`，schema 版本管理按此 id 索引。

#### 公共接口类型（行 153-187）

```typescript
export interface WorldGraphOptions {
  dbPath: string;
  eventLogPath: string;
}

export interface MigrateResult {
  fromVersion: number;
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

export interface TemporalQueryOpts {
  recordedAsOf?: string;
}
```

`WorldGraphOptions` 是 `create` / `migrate` 的入参，纯路径，无其他配置。
`TemporalQueryOpts.recordedAsOf` 是双时态查询的事务时间坐标，由 `recordedNow()`
获取，形如 `"r1:0000000000000007:2026-07-25T16:02:32.048Z"`，字典序可比较。

#### `WorldGraph` 类字段与构造（行 189-229）

```typescript
export class WorldGraph {
  private db: Database.Database;
  private store: HistoryStore<typeof graph>;
  private eventLog: EventLog;
  private _writeLock: Promise<void> = Promise.resolve();

  private constructor(db, store, eventLog) { ... }

  private async withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this._writeLock;
    let release!: () => void;
    this._writeLock = new Promise<void>((resolve) => { release = resolve; });
    await prev;
    try { return await fn(); } finally { release(); }
  }
}
```

构造函数是 `private`，强制走 `create` 异步工厂。`_writeLock` + `withWriteLock`
是 0.1.1 新增的 async mutex，保证 `processEvent` 串行执行（多步异步写并发会交错）。

注释明确：**范围只锁 processEvent**。`birthEntity` / `killEntity` / `setVisibility`
等单一写入方法未加锁；若外部混用 `processEvent` 与这些方法，仍可能交错。完整隔离需
消费方自行避免并发混用，或后续扩展锁覆盖所有写入方法。

#### `create` 异步工厂（行 241-257）

```typescript
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
    db.close();
    throw err;
  }
}
```

逐行：

1. `new Database(opts.dbPath)` — 打开/创建 SQLite 文件。
2. `db.pragma("journal_mode = WAL")` — 启用 WAL 模式，提升并发读性能。
3. `loadSqliteVec(db)` — 加载 sqlite-vec 扩展，使向量 DDL/写入/检索可用。
4. `drizzle(db)` — 包装为 drizzle ORM 实例。
5. `db.exec(generateSqliteMigrationSQL())` — 生成并执行 SQLite 迁移 DDL
   （建表、索引等）。
6. `createSqliteBackend(drizzleDb, { vector: sqliteVecStrategy })` — 创建后端，
   指定向量策略为 sqlite-vec。
7. `createStoreWithSchema(graph, backend, { history: true })` — 用 graph 定义
   初始化 store，`history: true` 启用双时态历史记录。
8. `new EventLog(opts.eventLogPath)` — 创建事件日志（不打开文件）。
9. `new WorldGraph(...)` — 返回实例。

`catch` 块：schema 校验失败（如 `MIGRATION_ERROR`）时释放句柄，避免占用 db 文件。

#### `migrate` 静态方法（行 270-287）

```typescript
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
```

用途：旧版引擎创建的 `world.db` 在新版代码下 `create` 会抛 `MIGRATION_ERROR`
（schema 定义有变更）。本方法用当前 graph 定义提交新 schema 版本，完成后 `create`
即可正常打开。

**安全约束**：调用方负责在调用前备份 db 文件。

#### `close` / `search` / `query` / `recordedNow`（行 289-317）

```typescript
close(): void {
  this.eventLog.close();
  this.db.close();
}

get search() {
  return this.store.search;
}

query() {
  return this.store.query();
}

async recordedNow(): Promise<string | undefined> {
  const instant = await this.store.recordedNow();
  return instant as string | undefined;
}
```

- `close` — 0.1.1 加了 `eventLog.close()`（no-op）保证资源语义对称。
- `search` getter — 透传 SDK `StoreSearch`，调用方可用 `fulltext` / `vector` / `hybrid`。
- `query()` — 透传 SDK `QueryBuilder`，供复杂图遍历查询。
- `recordedNow()` — 当前事务时间坐标。空图（尚无写入）返回 `undefined`。

#### `findNodes` 私有方法（行 324-343）

```typescript
private async findNodes(
  kind: "Entity" | "Fact" | "Relation" | "Visibility",
  recordedAsOf?: string,
): Promise<GraphRecord[]> {
  if (!recordedAsOf) {
    return await (this.store.nodes as any)[kind].find() as GraphRecord[];
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
```

双时态节点读取：带 `recordedAsOf` 时走 SDK `RecordedStoreView` 重建该事务时点的
节点状态（含后续被闭合/修改的字段原值）；否则走 live `find()`。`scan` 单页上限 1000，
循环翻页取全量。

`as any` 是 SDK mapped type 动态访问的已知限制，0.1.1 加了注释说明。

#### 实体生命周期方法（行 345-471）

```typescript
async birthEntity(entityId, entityType, initialProps, storyTime, summary?): Promise<void>
async killEntity(entityId, storyTime): Promise<void>
async getEntityAt(entityId, storyTime, opts?): Promise<EntitySnapshot | null>
async updateEntitySummary(entityId, summary): Promise<void>
```

- `birthEntity` — 创建 Entity 节点 + 循环创建 Fact 节点（initialProps 的每个键值对一个 Fact）。
  `declarationId` 格式 `decl-{entityId}-{prop}-{storyTime}`。
- `killEntity` — 闭合 Entity 的 `validTo`，级联闭合该实体所有未闭合 Fact。
  找不到实体或已死时抛错。
- `getEntityAt` — bi-temporal 快照查询。`validFrom <= storyTime < validTo`
  （特判 INFINITY），叠加 `recordedAsOf`（事务时间轴）。
- `updateEntitySummary` — 直接覆盖当前 Entity 的 summary，不参与时态。

#### 关系方法（行 436-504）

```typescript
async addRelation(sourceId, targetId, label, storyTime): Promise<void>
async closeRelation(sourceId, targetId, label, storyTime): Promise<void>
async getRelations(entityId, storyTime, opts?): Promise<Array<{...}>>
```

`relationId` 格式 `rel-{sourceId}-{label}-{targetId}-{storyTime}`。
`closeRelation` 找不到匹配未闭合关系时抛错。

#### `processEvent` 事件入口（行 506-566）

```typescript
async processEvent(input: EventRecordInput): Promise<void> {
  return this.withWriteLock(() => this._processEvent(input));
}

private async _processEvent(input: EventRecordInput): Promise<void> {
  const event = EventRecord.parse({
    recordedAt: new Date().toISOString(),
    ...input,
  });
  await this.eventLog.append(event);

  switch (event.type) {
    case "birth":
      await this.birthEntity(...);
      break;
    case "death":
      await this.killEntity(event.entityId, event.storyTime);
      break;
    case "change":
      // 闭合旧声明 + 写入新声明
      ...
      break;
  }
}
```

0.1.1 拆为 `processEvent`（加锁）+ `_processEvent`（实际逻辑）。0.1.2 再拆
`_applyEvent(tx, event)`：先 append JSONL（审计优先，即使状态回滚日志也保留），
再 `runInTransaction` 包 SDK `store.transaction(tx)`，事务内所有节点读写走
`tx.nodes`，中途失败整体回滚，不留半成品。`recordedAt` 缺省填充当前时间，
调用方显式传入时优先，再按 type 分派。

**事务约束（0.1.2 实测）**：外层不能用 `db.exec("BEGIN")` 包裹 —— SDK 写入自带
事务，会报 "cannot start a transaction within a transaction"；事务内穿插 `store`
直读会触发 SDK deadlock 报错，必须统一走 `tx` 上下文。`birthEntity` / `killEntity`
重构为 core 方法 + 双路由（普通调用走 `store.nodes`，事务内复用 `tx.nodes`）。

**birth 分支的已知问题**：`Object.fromEntries((event.newFacts ?? []).map((f) => [f.property, f.value]))`
同 property 多条 newFacts 互相覆盖只留最后一条；newFacts.entityId 被完全忽略，
跨实体 newFacts 静默丢失。这是 D 类需对齐的修复。

#### 事件查询方法（行 568-576）

```typescript
async traceCauses(eventId): Promise<EventRecord[]>
async getAllEvents(): Promise<EventRecord[]>
```

`traceCauses` 委托给 `eventLog.traceBack`。`getAllEvents` 按 `storyTime` 升序。

#### 可见性方法（行 578-662）

```typescript
async setVisibility(characterId, declarationId, opts): Promise<void>
async getVisibilityForCharacter(characterId, storyTime, opts?): Promise<VisibilityDeclaration[]>
async closeVisibility(characterId, declarationId, storyTime): Promise<void>
async getVisibilityForDeclaration(declarationId, storyTime?): Promise<VisibilityDeclaration[]>
```

`setVisibility` 的 `visibilityId` 格式 `vis-{characterId}-{declarationId}-{validFrom}`。
`closeVisibility` 找不到匹配未闭合记录时抛错。

#### 声明查询方法（行 664-696）

```typescript
async getAllDeclarationsAt(storyTime, opts?): Promise<StateDeclaration[]>
async getAllDeclarations(opts?): Promise<StateDeclaration[]>
```

`getAllDeclarations` 不做时态过滤，含已闭合，供 character_view 的"知识持续"语义使用。

#### 关系查询方法（行 698-714）

```typescript
async getAllRelationsAt(storyTime, opts?): Promise<Array<{...}>>
```

#### 视角代理方法（行 716-728）

```typescript
async inferVisibility(storyTime): Promise<void>
async getCharacterView(characterId, storyTime, opts?): Promise<StateDeclaration[]>
```

动态 `import("./character-view.js")` 调用 character-view.ts 的函数。延迟 import
避免循环依赖。

#### 实体查询方法（行 730-818）

```typescript
async getAllEntities(storyTime, opts?): Promise<EntitySnapshot[]>
async getEntityHistory(entityId): Promise<{ entities, facts }>
async getRelationHistory(entityId?): Promise<Array<{...}>>
```

`getEntityHistory` 返回单个实体的全部版本（含已闭合记录）+ 全部 Fact（含历史），
按 `validFrom` 升序。Fact 附带 `meta.createdAt` / `meta.updatedAt`（SDK 元信息，
旧数据可能缺失）。

#### `listStoryTimes`（行 825-840）

```typescript
async listStoryTimes(): Promise<string[]>
```

从 events + Entity/Fact/Relation/Visibility 的 validFrom/validTo 聚合所有出现过的
storyTime，去重升序，排除 `"Infinity"`。供前端 storyTime 快照选择器使用。

#### Embedding 方法（行 854-930）

```typescript
async reembedAll(embedder: { embedEntity, embedFact }): Promise<void>
async updateFactEmbedding(declarationId, embedding): Promise<void>
async updateEntityEmbedding(entityId, embedding): Promise<void>
```

- `reembedAll` — 重新嵌入所有 Entity 与 Fact 的向量。Entity 用其 validFrom（诞生时刻）
  取快照，Fact 直接构造 StateDeclaration 传入。
- `updateFactEmbedding` — commit.ts 写扩散后增量更新单条向量，避免全量 reembedAll
  性能开销。找不到 declarationId 时静默跳过。
- `updateEntityEmbedding` — Entity.summary 变化时调用。预留 API。

`asEmbedding(vec)` 集中处理 branded type 双重断言。

### 5.9 `scripts/smoke.mjs` — 端到端冒烟

**职责**：Macbeth 故事片段端到端冒烟，7 个步骤覆盖核心 API。

```javascript
import { WorldGraph } from "../src/index.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), "wg-smoke-"));
const wg = await WorldGraph.create({
  dbPath: join(dir, "world.db"),
  eventLogPath: join(dir, "events.jsonl"),
});
```

`mkdtempSync` 创建临时目录，结束后 `rmSync` 递归删除。`import` 直接引用
`../src/index.ts`（tsx 支持）。

7 个步骤：

1. `birthEntity` macbeth + inverness。
2. `addRelation` located_in。
3. `processEvent` change（Duncan 访问 Inverness）。
4. `inferVisibility`。
5. `getCharacterView`（Macbeth 视角）。
6. `traceCauses`。
7. `killEntity` + 验证消亡后查不到。

成功输出 `✅ 端到端冒烟全部通过`。

### 5.10 `.github/workflows/ci.yml` — CI 流水线

**职责**：GitHub Actions CI，push master / tag / PR 时触发。

```yaml
on:
  push:
    branches: [master]
    tags: ["v*"]
  pull_request:
    branches: [master]
```

两个 job：

- `test` — Node 20 / 22 矩阵跑 typecheck + build + test。
- `publish` — 仅 tag `v*` 触发，`needs: test` 通过后才跑。`NPM_TOKEN` 未配置时
  publish step 自动跳过（避免 401 变红）。

`publish` 用 `--provenance` 启用 npm 包来源证明（npm provenance），
`id-token: write` 权限是 provenance 必需。

---

## 6. API 速查表

### 工厂与生命周期

| 方法 | 签名 | 说明 |
|---|---|---|
| `WorldGraph.create` | `(opts: WorldGraphOptions) => Promise<WorldGraph>` | 异步工厂，初始化 SQLite + sqlite-vec + TypeGraph |
| `WorldGraph.migrate` | `(opts: WorldGraphOptions) => Promise<MigrateResult>` | schema 版本迁移 |
| `wg.close` | `() => void` | 释放 db 句柄（含 EventLog.close） |

### 实体

| 方法 | 说明 |
|---|---|
| `birthEntity(entityId, type, initialProps, storyTime, summary?)` | 诞生实体 + 初始属性 |
| `killEntity(entityId, storyTime)` | 消亡实体，级联闭合 Fact |
| `getEntityAt(entityId, storyTime, opts?)` | bi-temporal 快照 |
| `getAllEntities(storyTime, opts?)` | 全部有效实体 |
| `getEntityHistory(entityId)` | 全部版本（含已闭合） |
| `updateEntitySummary(entityId, summary)` | 直接覆盖 summary |

### 关系

| 方法 | 说明 |
|---|---|
| `addRelation(sourceId, targetId, label, storyTime)` | 创建关系 |
| `closeRelation(sourceId, targetId, label, storyTime)` | 闭合关系 |
| `getRelations(entityId, storyTime, opts?)` | bi-temporal 关系查询 |
| `getRelationHistory(entityId?)` | 全部关系（含已闭合） |

### 事件

| 方法 | 说明 |
|---|---|
| `processEvent(input)` | 追加事件 + 应用副作用（birth/death/change） |
| `traceCauses(eventId)` | 沿 causedBy 回溯因果链 |
| `getAllEvents()` | 全部事件（按 storyTime 升序） |

### 可见性

| 方法 | 说明 |
|---|---|
| `setVisibility(characterId, declarationId, opts)` | 显式声明角色知道某声明 |
| `closeVisibility(characterId, declarationId, storyTime)` | 撤销可见性 |
| `getVisibilityForCharacter(characterId, storyTime, opts?)` | 角色可见的声明 |
| `getVisibilityForDeclaration(declarationId, storyTime?)` | 声明被哪些角色可见 |
| `inferVisibility(storyTime)` | 从 located_in 自动推断 |
| `getCharacterView(characterId, storyTime, opts?)` | 角色视角（五步过滤） |

### 声明

| 方法 | 说明 |
|---|---|
| `getAllDeclarationsAt(storyTime, opts?)` | storyTime 时刻有效声明 |
| `getAllDeclarations(opts?)` | 全部声明（含已闭合，知识持续） |

### 检索

| 方法 | 说明 |
|---|---|
| `wg.search` | SDK StoreSearch（fulltext / vector / hybrid） |
| `wg.query()` | SDK QueryBuilder 入口 |
| `wg.recordedNow()` | 当前事务时间坐标 |
| `reembedAll(embedder)` | 全量重嵌入向量 |
| `updateFactEmbedding(declarationId, vec)` | 增量更新单条 Fact 向量 |
| `updateEntityEmbedding(entityId, vec)` | 增量更新单条 Entity 向量 |

### 工具

| 方法 | 说明 |
|---|---|
| `listStoryTimes()` | 所有出现过的 storyTime |
| `wg.close()` | 释放资源 |

### 公共类型

```typescript
import {
  WorldGraph,
  EntityType,         // "character" | "location" | "item" | "concept"
  Modality,           // "fact" | "belief" | "hypothesis"
  EventType,          // "birth" | "death" | "change"
  StateDeclaration,
  EventRecord,
} from "underworld-graph";
import type {
  EntitySnapshot,
  MigrateResult,
  EventRecordInput,
} from "underworld-graph";
```

### 内部类型（_ 前缀，不保证稳定）

```typescript
import {
  _EventSource,
  _VisibilityDeclaration,
  _INFRA_RELATIONS,
} from "underworld-graph";
import type {
  _WorldGraphOptions,
  _TemporalQueryOpts,
} from "underworld-graph";
```

---

## 7. 数据模型与存储布局

### 7.1 两个文件

部署后运行时目录会有 4 个文件：

| 文件 | 内容 | 重要度 |
|---|---|---|
| `world.db` | SQLite 主数据库，含 Entity/Fact/Relation/Visibility 节点 + TypeGraph 元表 + 向量索引 | 必备 |
| `world.db-wal` | SQLite WAL 日志（写入预写日志） | 自动管理 |
| `world.db-shm` | SQLite 共享内存（WAL 模式辅助） | 自动管理 |
| `events.jsonl` | JSONL 事件日志，每行一个 EventRecord | 必备 |

### 7.2 节点类型与字段

| 节点 | 字段 | 备注 |
|---|---|---|
| **Entity** | entityId, type, summary, validFrom, validTo, embedding? | embedding 512 维 |
| **Fact** | declarationId, entityId, property, value, valueText?, embedding?, modality, validFrom, validTo | property/valueText 启用 zh 全文检索 |
| **Relation** | relationId, sourceId, targetId, label, validFrom, validTo | 三元组 |
| **Visibility** | visibilityId, characterId, declarationId, state, confidence, source, validFrom, validTo, isExplicit | state 当前只有 "known" |

### 7.3 ID 生成约定

| 实体 | ID 格式 |
|---|---|
| Fact | `decl-{entityId}-{property}-{storyTime}` |
| Relation | `rel-{sourceId}-{label}-{targetId}-{storyTime}` |
| Visibility | `vis-{characterId}-{declarationId}-{validFrom}` |
| Event | 调用方生成（建议 UUID 或时间戳+随机） |

### 7.4 时态模型

**双时态**（bi-temporal）：

- **故事时间轴**（story time）：`validFrom` / `validTo`，故事世界内的时间。
  `"Infinity"` 表示未闭合。
- **事务时间轴**（transaction time）：`recordedAt`（事件日志）和 SDK recorded
  instant（节点元信息），墙钟时间，记录"何时写入"。

`getEntityAt` 等 bi-temporal 查询：`validFrom <= storyTime < validTo`（特判 INFINITY）
叠加 `opts.recordedAsOf`（只含该时点之前写入的内容，retcon 隔离）。

### 7.5 SQLite 模式

`world.db` 内部表结构由 typegraph SDK 通过 `generateSqliteMigrationSQL()` 生成，
包括：

- 节点表（每类节点一张）
- 系统索引表（fulltext / vector / materialized）
- schema 版本表（`getActiveSchema` 读此表）
- 历史表（`history: true` 启用，记录每次写入的事务时间）

**不要手动改 SQLite 表结构**。schema 变更只能通过修改 graph 定义 +
`WorldGraph.migrate()` 走 SDK 迁移流程。

---

## 8. 运维与备份

### 8.1 备份策略

```bash
# 在线备份（不影响运行中的服务）
sqlite3 /var/lib/your-service/world/world.db ".backup '/backup/world-$(date +%F).db'"

# 事件日志直接复制（append-only，复制即可）
cp /var/lib/your-service/world/events.jsonl /backup/events-$(date +%F).jsonl

# 自动化（cron 每日凌晨 3 点）
echo '0 3 * * * root sqlite3 /var/lib/.../world.db ".backup \"/backup/world-$(date +\%F).db\"" && cp /var/lib/.../events.jsonl /backup/events-$(date +\%F).jsonl' | sudo tee /etc/cron.d/world-backup
```

### 8.2 恢复

```bash
# 停服务
sudo systemctl stop your-service

# 恢复备份
cp /backup/world-2026-08-03.db /var/lib/your-service/world/world.db
cp /backup/events-2026-08-03.jsonl /var/lib/your-service/world/events.jsonl

# 删 WAL/SHM（让 SQLite 从主 db 重新启动）
rm -f /var/lib/your-service/world/world.db-wal /var/lib/your-service/world/world.db-shm

# 启服务
sudo systemctl start your-service
```

### 8.3 监控指标

| 指标 | 获取方式 | 告警阈值 |
|---|---|---|
| db 文件大小 | `ls -la world.db` | > 1GB 时关注 |
| 事件日志行数 | `wc -l events.jsonl` | 增长率突变时关注 |
| 进程内存 | `systemctl status your-service` | 持续上涨可能是 EventLog 全量读取累积 |
| 写入延迟 | 服务自定义指标 | > 1s 时关注（可能 SQLite 锁竞争） |

### 8.4 升级 underworld-graph

```bash
# 1. 备份（必须！schema 变更可能不可逆）
sqlite3 ... ".backup ..."

# 2. 升级依赖
cd /opt/your-service
npm install underworld-graph@<新版本>

# 3. 重启服务
sudo systemctl restart your-service

# 4. 若启动报 MIGRATION_ERROR，跑迁移
# 在你的服务代码里加一次性迁移脚本：
# const result = await WorldGraph.migrate({ dbPath, eventLogPath });
# console.log(`migrated ${result.fromVersion} -> ${result.toVersion}`);
```

### 8.5 多进程注意事项

**SQLite 是单写者**。不要让多个进程同时打开同一个 `world.db` 写入。

若必须多进程：

- 每个进程独立 `dbPath`（数据分片）。
- 或上层加分布式锁，确保同一时刻只有一个进程持有写权限。
- WAL 模式允许并发读，但写仍串行。

`processEvent` 内部的 `_writeLock` 只保证单进程内的串行化，不跨进程。

---

## 9. 已知问题清单

> 本章节汇总所有已识别的问题，按修复风险分四级。每项给出：问题描述、影响范围、
> 修复方案、风险等级、当前状态。
>
> 来源：[`docs/design-review-2026-08-02.md`](./design-review-2026-08-02.md) 的 14 项设计评审
> + 0.1.1 开发期新发现的 10 项，共 24 项。
>
> **风险分级定义**：
> - **A 类**：纯内部清理，零下游影响，可直接修。
> - **B 类**：向后兼容的实现优化，API 不变，行为更合理，零下游影响。
> - **C 类**：向后兼容的 API 扩展（新增可选参数/方法，原行为不变）。
> - **D 类：需消费方对齐的破坏性修复**，改了会触发 MIGRATION_ERROR、改变 SQLite
>   schema、改变公开输出字段或现有调用语义，**必须先与 narrative-engine / novel
>   消费方对齐才能动**。

### 9.1 A 类：已修复（0.1.1，7 项）

| # | 问题 | 影响 | 修复方案 | 状态 |
|---|---|---|---|---|
| A1 | [Infinity 哨兵重复定义](file:///d:/claude/pi-ex/underworld-graph/src/character-view.ts) — character-view.ts 本地定义 `"Infinity"` 字符串，与 types.ts 不一致 | 字符串字面量散落，未来改哨兵值会漏改 | 导出 `INFINITY` 常量到 types.ts，character-view.ts 引用之，删除 dead code | ✅ 0.1.1 已修 |
| A2 | 大量 `any` / `as unknown as EmbeddingValue` 散落 [world-graph.ts](file:///d:/claude/pi-ex/underworld-graph/src/world-graph.ts) | 类型安全缺失，重构易出错 | `findNodes` 返回 `GraphRecord[]`，30+ 处 `(x: any)` 改类型化；抽 `asEmbedding` helper 集中 branded type 断言 | ✅ 0.1.1 已修 |
| A3 | [processEvent](file:///d:/claude/pi-ex/underworld-graph/src/world-graph.ts) 无并发控制，多步异步写并发会交错 | 并发写入导致状态图与日志不一致 | 内部加 `_writeLock` + `withWriteLock` async mutex，拆出 `_processEvent` 私有方法，API 不变 | ✅ 0.1.1 已修 |
| A4 | [EventLog](file:///d:/claude/pi-ex/underworld-graph/src/event-log.ts) 无 `close()`，与 WorldGraph.close 资源语义不对称 | 调用方无法统一释放资源 | 加 no-op `close()`，WorldGraph.close 调用之 | ✅ 0.1.1 已修 |
| A5 | README "migrate legacy db schema" 名不副实 | 误导消费方以为有 legacy 数据迁移工具 | 改 README 措辞为 TypeGraph schema version | ✅ 0.1.1 已修 |
| A6 | typegraph 版本 `^0.40.0` 未锁 minor | minor 升级可能引入不兼容 | `package.json` 改 `~0.40.0`（锁 minor 允许 patch） | ✅ 0.1.1 已修 |
| A7 | [declaresEdge](file:///d:/claude/pi-ex/underworld-graph/src/world-graph.ts) 定义但从不使用 | 后人误以为是 dead code 删除，触发 schema_hash 变化 | 补注释说明"预留未用，删除会触发 MIGRATION_ERROR"，**不删除** | ✅ 0.1.1 已修 |

### 9.2 B 类：已修复（0.1.2，4 项）+ 待修复（1 项）

> API 不变，行为更合理，零下游影响。B1-B4 已在 0.1.2 修复，每项均配套回归测试；
> B5（性能）仍待修，先做基准测试确认量级收益。

| # | 问题 | 影响 | 修复方案 | 风险点 | 状态 |
|---|---|---|---|---|---|
| B1 | [valueText 序列化错误](file:///d:/claude/pi-ex/underworld-graph/src/world-graph.ts) — `String(val)` 对对象/数组变成 `[object Object]` | 全文索引建在错误文本上，对象类 value 无法被检索 | 抽 `serializeValueText()` helper：对象 JSON.stringify、Date 走 ISO（Invalid Date 兜底 String）、循环引用回退 String | valueText 不在公开输出里（评审 P2-8 已记），消费方读不到，零影响 | ✅ 0.1.2 已修 |
| B2 | [EventLog 单行损坏全文件读不出](file:///d:/claude/pi-ex/underworld-graph/src/event-log.ts) — `readAll` 任意一行 `JSON.parse` 失败会抛错 | 日志文件局部损坏导致整个 `traceBack` / `getAllEvents` 不可用 | `readAll` 逐行 try/catch + `EventRecord.safeParse`，语法损坏与形状不符行跳过（记 stderr） | 消费方不太可能依赖"抛错"语义 | ✅ 0.1.2 已修 |
| B3 | [inferVisibility 无幂等](file:///d:/claude/pi-ex/underworld-graph/src/character-view.ts) — 重复调用同 storyTime 产生重复 visibility 记录 | 同一 (characterId, declarationId) 多条 visibility 记录，查询结果重复 | 写入前全历史判定（含已闭合）：当前可见跳过；存在 `validTo <= storyTime` 撤销记录则 validFrom 取当前时刻 | 消费方不太可能依赖"重复调用产生重复记录" | ✅ 0.1.2 已修 |
| B4 | [birthEntity / processEvent.change 无事务回滚](file:///d:/claude/pi-ex/underworld-graph/src/world-graph.ts) — 多步写中途失败留下半成品 | Entity 已建但 Fact 没建全，或旧声明已闭合但新声明没写入，状态不一致 | 多步写包 SDK `store.transaction(tx)`（SDK 自带事务，外层 raw BEGIN 会冲突），事务内读写走 `tx.nodes`，失败整体回滚 | 日志语义已定：JSONL 先写保留审计，状态回滚；未加 `_failed` 标记 | ✅ 0.1.2 已修 |
| B5 | [killEntity / closeRelation 全表扫描](file:///d:/claude/pi-ex/underworld-graph/src/world-graph.ts) 等 6 处 — 用 `find()` 取全量再 JS filter | 数据量大后查询慢（O(n) 扫描） | 用 SDK `query()` 按 entityId 索引替代 find() + JS filter | 需先做基准测试确认量级收益 | 待修 |

### 9.3 C 类：待修复 — 向后兼容的 API 扩展（4 项）

> 新增可选参数/方法，原行为不变。可立即修，给消费方提供可选的严格模式 / upsert 入口。

| # | 问题 | 影响 | 修复方案 | 风险点 |
|---|---|---|---|---|
| C1 | [migrate 接口签名不一致](file:///d:/claude/pi-ex/underworld-graph/src/world-graph.ts) — `migrate` 只接受 `{ dbPath }`，不接受 `WorldGraphOptions` | 调用方需为 migrate 单独构造参数，与 create 不对称 | migrate 改为接受 `WorldGraphOptions \| { dbPath: string }`，两种都兼容 | 向后兼容 |
| C2 | [getEntityHistory 等不支持 recordedAsOf](file:///d:/claude/pi-ex/underworld-graph/src/world-graph.ts) — 4 个 history 方法无法做 retcon 隔离查询 | 无法查"某事务时点前的历史快照" | 4 个方法加可选 `opts?: TemporalQueryOpts`，内部走 findNodes | 向后兼容 |
| C3 | [写入无幂等](file:///d:/claude/pi-ex/underworld-graph/src/world-graph.ts) — birthEntity / setVisibility 重复调用产生重复记录 | 上层重试逻辑会导致数据膨胀 | 新增 `birthEntityUpsert` / `setVisibilityIfAbsent` 等可选方法，原方法不动 | 向后兼容 |
| C4 | [无引用完整性校验](file:///d:/claude/pi-ex/underworld-graph/src/world-graph.ts) — 写 Fact 时不校验 entityId 是否存在 | 可以为不存在的实体写声明，查询时孤儿声明 | 写入方法加可选 `{ strict?: boolean }` 参数，默认 false 保持原行为 | 向后兼容 |

### 9.4 D 类：待修复 — 需消费方对齐的破坏性修复（8 项）

> 改了会触发 MIGRATION_ERROR、改变 SQLite schema、改变公开输出字段、或改变现有调用语义，
> **必须先与 narrative-engine / novel 消费方对齐**。

| # | 问题 | 影响 | 修复方案 | 对齐难点 |
|---|---|---|---|---|
| D1 | storyTime 格式无校验（P1-4） — 任意字符串都接受，依赖字典序比较 | 调用方传入不可比较的格式（如 `2026/8/3`）会让时态过滤错乱 | 加 zod regex 校验，约定格式（如 `act\d+-scene\d+` 或 ISO 日期） | 改接受格式会让消费方现有数据失效 |
| D2 | birth 事件 newFacts 语义缺陷 — `Object.fromEntries` 同 property 多条互相覆盖；newFacts.entityId 被忽略 | 同一 birth 事件无法给同实体多值属性；跨实体 newFacts 静默丢失 | birthEntity 改为遍历 newFacts 逐条写 Fact，保留 entityId 字段 | 改变 birthEntity 行为，消费方现有调用结果不同 |
| D3 | birth 事件保留 modality（评审 P2-8） — 当前硬编码 `"fact"` | birth 的 newFacts.modality 字段被忽略，所有诞生声明都是 fact | birthEntity 透传 newFacts.modality | 改变 birth 声明的 modality 分布，characterView 的 modalityFilter 结果变化 |
| D4 | killEntity 级联关 Relation（评审 P2-8 + 新发现） — 死亡实体的 located_in 关系不自动闭合 | 死亡实体仍出现在关系查询，inferVisibility 仍为死者推断可见性 | killEntity 级联闭合该实体的所有未闭合 Relation | 死亡实体从关系查询消失，inferVisibility 不再推死者声明 |
| D5 | updateEntitySummary 写事件 + 触发重嵌入（评审 P2-8） — 当前直接覆盖，无事件日志 | summary 变更不可回溯，向量不更新 | 改为写 change 事件 + 触发 updateEntityEmbedding | 新增事件日志行，getAllEvents 结果变化 |
| D6 | VisibilityNode.state 单值枚举 — 当前只有 `"known"`，字段冗余 | schema 占用但无实际语义 | 删字段会改 schema_hash → MIGRATION_ERROR | 暂保留，等下次 schema 大改时一并清理 |
| D7 | traceCauses 不存在 eventId 语义 — `causedBy` 指向不存在事件时返回 `[]`，与"无前驱"不可区分 | 调用方无法区分"事件是根因"和"前驱丢失" | 区分：无 causedBy 返回 `[event]`；causedBy 不存在抛错或返回 `null` | 消费方分支逻辑会变 |
| D8 | 事务时间两套钟统一（评审 P3-11） — EventLog.recordedAt 与 SDK recorded instant 不一致 | 双时态查询的事务时间坐标不统一 | 统一为 SDK recorded instant，EventLog.recordedAt 改为引用之 | recordedAt 字段语义变化，旧日志不一致 |

### 9.5 监控建议

部署后建议在服务层加这些日志/指标：

- `processEvent` 调用频率与延迟分布。
- `getEntityAt` / `getCharacterView` 查询延迟（数据量大后可能慢）。
- 事件日志行数增长率（异常增长可能表示上层重复触发，与 B3 幂等问题相关）。
- SQLite WAL 大小（持续增长不回落可能表示检查点失败）。
- 0.1.2 已落地 B2/B3 修复；建议加"损坏日志行跳过计数"与"重复 visibility 跳过计数"
  指标，观察其发生频率（长期接近 0 则说明日志写入与推断逻辑健康）。

---

## 附录 A：完整 Quick Start

```typescript
import { WorldGraph } from "underworld-graph";
import path from "node:path";

// 1. 创建实例
const wg = await WorldGraph.create({
  dbPath: path.join(process.cwd(), "data", "world.db"),
  eventLogPath: path.join(process.cwd(), "data", "events.jsonl"),
});

try {
  // 2. 诞生实体
  await wg.birthEntity("ent-macbeth", "character", { title: "Thane of Glamis" }, "act1-scene1");
  await wg.birthEntity("ent-inverness", "location", { temp: "cold" }, "act1-scene1");

  // 3. 建立关系
  await wg.addRelation("ent-macbeth", "ent-inverness", "located_in", "act1-scene1");

  // 4. 事件驱动状态变更
  await wg.processEvent({
    eventId: "evt-1",
    type: "change",
    storyTime: "act1-scene4",
    entityId: "ent-inverness",
    invalidated: [],
    newFacts: [
      { entityId: "ent-inverness", property: "visitor", value: "Duncan", modality: "fact" },
    ],
    userInput: "邓肯王来到因弗内斯城堡",
  });

  // 5. 推断可见性（同地点互相可见）
  await wg.inferVisibility("act1-scene4");

  // 6. 查询角色视角
  const view = await wg.getCharacterView("ent-macbeth", "act1-scene4", { modalityFilter: ["fact"] });
  console.log("Macbeth 视角可见声明数:", view.length);

  // 7. 回溯因果链
  const chain = await wg.traceCauses("evt-1");
  console.log("因果链长度:", chain.length);

  // 8. 双时态查询（retcon 隔离）
  const recordedNow = await wg.recordedNow();
  // ... 此处可能有 retcon 写入 ...
  const snapshot = await wg.getEntityAt("ent-macbeth", "act1-scene4", { recordedAsOf: recordedNow });
  console.log("retcon 隔离快照:", snapshot);

  // 9. 全文检索
  const results = await wg.search.fulltext({
    node: "Fact",
    query: "visitor",
    limit: 10,
  });
  console.log("全文检索结果:", results);

  // 10. 消亡实体
  await wg.killEntity("ent-inverness", "act5-scene1");
} finally {
  wg.close();
}
```

## 附录 B：环境变量建议

部署时建议你的服务读取这些环境变量：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `WG_DATA_DIR` | `./data` | db 与 events.jsonl 的存放目录 |
| `WG_DB_PATH` | `${WG_DATA_DIR}/world.db` | 显式覆盖 db 路径 |
| `WG_EVENT_LOG_PATH` | `${WG_DATA_DIR}/events.jsonl` | 显式覆盖日志路径 |
| `NODE_ENV` | - | `production` 时启用优化 |
| `PI_DEBUG` | - | 设为 `off` 时关闭调试模块 |

## 附录 C：版本发布检查清单

发布新版本时：

- [ ] 跑 `npm run typecheck`
- [ ] 跑 `npm test`（66 用例全绿）
- [ ] 跑 `npm run smoke`（端到端冒烟通过）
- [ ] 更新 `CHANGELOG.md`
- [ ] bump `package.json` version
- [ ] 按 AGENTS.md 分支策略：建分支 → 提交 → ff-only 合并 master
- [ ] `git push origin master`
- [ ] `git tag v<x.y.z>` + `git push origin v<x.y.z>`（触发 CI publish）
- [ ] 或手动 `npm publish --registry=https://registry.npmjs.org`

---

**文档版本**：对应 `underworld-graph@0.1.2`，2026-08-05 更新。
**源码版本**：commit `9d5e28d`（master HEAD）。
**问题反馈**：[GitHub Issues](https://github.com/lmy414/underworld-graph/issues)。

---

## 维护约定

本 Markdown 文档与同目录的 `DEPLOYMENT.html` 是同一份内容的两种形态。
每次更新文档内容时，同步更新两者：

1. 先改 `docs/DEPLOYMENT.md`（源）
2. 再覆盖 `docs/DEPLOYMENT.html`
3. 两者在同一 commit 内提交，commit message 标注 `docs:` 前缀
4. HTML 是自包含单页（内嵌 CSS，无外部依赖），可直接部署到任意静态服务器

验证：HTML 顶部"对应版本"字段与 `package.json` 的 `version` 一致；底部"文档版本"commit hash 与当前 HEAD 一致。
