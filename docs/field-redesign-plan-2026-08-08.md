# 世界图字段补全实施计划（0.3.0）

> 日期：2026-08-08
> 状态：✅ **已审核，关键决策已拍板**（2026-08-08；待用户指令进 Phase 1，执行前不改动任何代码）
> 提出人：用户
> 关联文档：
> - `docs/field-model-discussion-2026-08-07.md`（字段语义与命名约定讨论记录）
> - `../narrative-engine/docs/plans/2026-08-08-underworld-graph-api-change-preparedness.md`（API 变更应对预案）
> - `docs/DEPLOYMENT.md` §9（已知问题台账）

---

## 一、背景与决策

### 1.1 决策记录（2026-08-08，用户拍板）

1. **结构不变**：数据库保持 4 类节点——实体（Entity）/ 关系（Relation）/ 状态（Fact）/ 可见性（Visibility）。
2. **补全而非重设计**：在现有模型基础上补全字段、增强健壮性（不是从 0 设计）。
3. **版本 0.3.0**：0.2.0 → 0.3.0（含破坏性变更，semver 0.x 沿用破例升 minor 惯例）。
4. **范围仅包底层**：本次只改 `underworld-graph` 包，**不修改 narrative-engine 引擎项目**（引擎适配、前端适配各立专项）。
5. **可见性节点不动**：结构、字段、语义全部保持原样。
6. **不兼容旧版本数据**（2026-08-08 用户拍板）：0.3.0 不做任何旧版本数据兼容——无运行时兼容层、无旧格式读取、无就地迁移。
7. **novel 存量库直接废弃**（2026-08-08 用户拍板）：清空数据库从 0 开始；不做迁移、不做回填，原"回填/映射表"工作整体消解。

### 1.2 动因（现状问题回顾）

- **实体**：无名称/别名字段，显示名依赖 `properties.name || entityId` fallback 链；已退场实体在可视化中退化成英文 ID。
- **关系**：label 一个字段兼职"类型标识"与"叙事描述"——58/80 条为一次性中文长句（唯一值 60），导致 closeRelation 精确匹配永远失败、80 条关系从未闭合、relationId 不可复现。
- **状态**：value 任意类型 + valueText 序列化文本双轨，valueText 输出裁剪不一致（E1 议题）；property 实际 99% 英文，规则集中文词表未被执行。
- **核心思想**：每个节点都有**稳定的可读文本字段**（实体名称/别名/描述、关系 label/描述、状态描述），展示层不再依赖时态窗口与 fallback 链。

---

## 二、设计定稿（四节点字段）

### 2.1 实体 Entity（+2 字段）

| 字段 | 类型 | 变更 | 说明 |
|---|---|---|---|
| entityId | string | ✅ 不变 | 唯一标识 |
| type | enum | ✅ 不变 | character/location/item/concept |
| **name** | string | ★ 新增 | **展示快照**：可视化直接读取；**非权威**——改名历史/可见性/检索仍由 Fact `property="名字"` 承载 |
| **aliases** | string[] | ★ 新增 | 别名快照，同 name 语义 |
| summary | string | ✅ 不变 | 实体无状态客观描述（现有"描述"） |
| validFrom/validTo | string | ✅ 不变 | 双时态窗口 |
| embedding | number[] | ✅ 不变 | 512 维向量 |

### 2.2 关系 Relation（+1 字段，label 语义收窄）

| 字段 | 类型 | 变更 | 说明 |
|---|---|---|---|
| relationId | string | ✅ 不变 | `rel-{src}-{label}-{tgt}-{storyTime}`；label 简单化后 ID 可复现 |
| sourceId/targetId | string | ✅ 不变 | 两端实体 |
| **label** | string | ★ 语义收窄 | 只承载**简单类型词**（规则集中文 12 枚举 + located_in 等保留词），作检索/闭合的精确匹配键 |
| **description** | string | ★ 新增 | 叙事描述（"KASSEN游戏中的对手，现实初次见面"这类长句归位到此） |
| validFrom/validTo | string | ✅ 不变 | 双时态窗口 |

### 2.3 状态 Fact（重构：−2 字段，+1 字段）

| 字段 | 类型 | 变更 | 说明 |
|---|---|---|---|
| declarationId | string | ✅ 不变 | `decl-{entityId}-{property}-{storyTime}`（property 中文化后 ID 内容随之变化） |
| entityId | string | ✅ 不变 | 属主实体 |
| **property** | string | ★ 中文词表 | 属性名改中文（规则集词表：character=名字/性格/背景/位置/心情/当前行动/职业…；location/item/concept 各有词表；跨实体=`信念.关于_{对象}.{方面}`） |
| **description** | string | ★ 新增 | 状态内容文本（searchable zh，进全文索引），一条状态一个可读描述；缺省可自动取原 value |
| modality | enum | ✅ 不变 | fact/belief/hypothesis |
| validFrom/validTo | string | ✅ 不变 | 双时态窗口 |
| ~~value~~ | ~~unknown~~ | ✂️ 删除 | 实测存量 189 条全部为 string，删除零损失 |
| ~~valueText~~ | ~~string~~ | ✂️ 删除 | 被 description 替代；E1 裁剪不一致（getEntityHistory 含/getEntityAt 不含）随之解决 |

### 2.4 可见性 Visibility

**完全不动**：visibilityId / characterId / declarationId / state(known) / confidence / source / isExplicit / validFrom / validTo。

---

## 三、实施范围

### 3.1 本次做（仅 underworld-graph 包，0.2.0 → 0.3.0）

1. schema 变更：`src/types.ts`、`src/world-graph.ts`（四节点定义 + 相关方法）
2. 迁移能力：`migrateSchema` 机制与既有测试保留（包能力，0.2.0 已有）；**novel 库不走迁移**（决策 7）
3. ~~回填脚本~~：**取消**（决策 7：存量废弃，无回填对象）
4. 包内测试全绿 + 文档同步（DEPLOYMENT/CHANGELOG/README/field-model-discussion）

### 3.2 本次不做（各立专项）

- narrative-engine 引擎适配（world-tools 18 工具 / import-card / visualizer routes / ports / search / project-registry）
- frontend-demo 前端适配（名字 fallback 链改直读 Entity.name、PROPERTY_LABELS 更新、value 展示改 description）
- **novel 旧库废弃清空 + 新库初始化**（随引擎适配专项执行，时序约束见 3.3）

### 3.3 ⚠️ 关键时序约束

```
包 0.3.0 发版（本次，仅交付包）
   │
   ▼ 引擎适配专项：升级 0.3.0 的同时
novel 旧库整体废弃（清空 .pi/world-graph-v3/：world.db + events.jsonl + 旁车文件）
   │
   ▼
全新初始化空库 → 角色卡重导 → 状态随写作重新积累

决策 6/7 后旧库从不被新代码打开，原 MIGRATION_ERROR 时序风险（见 §十.1）已消解。
本次仍遵循：包发版先行，引擎升级与库重建绑定进行。
```

---

## 四、代码改动面（包内）

| 文件 | 改动 |
|---|---|
| `src/types.ts` | StateDeclaration（删 value/valueText，+description）；EventRecord.newFacts 的 value → **description（必填，不做旧行兼容——决策 6）**；Entity/Relation 节点 schema（若在此定义） |
| `src/world-graph.ts` | 四节点 defineNode；`birthEntityCore`（+name/aliases 快照写入）；`addRelation`（+description 参数）；`processEvent.change`（newFacts 写 description）；`getEntityAt`/`getAllDeclarations*`/`getEntityHistory` 输出形状（value → description）；删除 `serializeValueText`；`updateEntitySummary` 照旧；**审查补遗**：GraphRecord 接口（value/valueText 字段）、`reembedAll` 内 StateDeclaration 构造、embedder 类型签名（`WorldGraphOptions.embedder`）同步 |
| `scripts/` | 无新增（回填/迁移验证脚本随决策 7 取消） |
| `tests/` | schema 迁移测试（包能力，保留）、新字段读写测试、E1 形状统一验证、新库端到端冒烟（含 description 全文检索命中） |

---

## 五、存量数据处置（2026-08-08 拍板：废弃，从 0 开始）

**决策：novel 存量库直接废弃，清空数据库从 0 开始；不做迁移、不做回填。**

废弃前事实记录（2026-08-08 实测 `.pi/world-graph-v3/`）：

- 30 实体（29 存活）/ 189 状态 / 80 关系（全部未闭合）/ 286 可见性（0 悬空引用）
- 关系唯一 label 60 个；含中文 label 58 条（其中短词"发小/同班同学/常客/看戏同谋" 8 实例、英文枚举 owns/related_to/knows/family_of/game_acquaintance 17 实例）
- 状态 property 27 个唯一值，185/189 纯英文；4 条 value 为数组（tags/alternate_greetings 角色卡导入件）
- 事件日志 89 条（birth 28 / change 60 / death 1），storyTime ch001.ev001 → ch012.ev010

废弃后不再需要：回填脚本、label/property 映射表（原 §九 ①②③ 消解）。新库直接以规则集词表
写入（引擎适配专项负责 world-tools 提示词对齐中文词表）。

归档发现（不再使用，仅备查）：`alias-index.json` 含每角色 name + aliases（如"酒寄彩叶"6 个别名），
原本可作为 Entity.aliases 回填来源；决策废弃后随库一并清空，由引擎别名索引机制重新积累。

同步规则（代码层，保留）：birth 时写 name 快照；改名（change 事件）时同步更新 `Entity.name`
（与 `updateEntitySummary` 同模式）。aliases 快照同理由引擎侧负责维护。

---

## 六、测试计划（包内）

1. **schema 迁移**：`migrateSchema` 包能力（0.2.0 既有测试保留）；novel 库不走迁移（决策 7）
2. ~~回填幂等~~：取消（无回填脚本）
3. **新字段读写**：name/aliases/description 写入与查询
4. ~~旧数据兼容读取~~：取消（决策 6：不做旧格式兼容）
5. **E1 关闭验证**：所有公开声明输出路径形状一致（均含 description、均不含 value/valueText）
6. **新库端到端冒烟**：空库初始化 → 写入 → 全文检索命中 description 内容（覆盖 searchable 字段变更后的索引可用性）

---

## 七、文档同步

- `docs/DEPLOYMENT.md`：schema 章节（§5.5/§5.6/§5.8）+ 台账 §9 追加 0.3.0 条目
- `CHANGELOG.md`：0.3.0 变更记录
- `README.md`：字段表更新
- `docs/field-model-discussion-2026-08-07.md`：决策状态更新（§6 未拍板项落定：property 中文词表 ✅、关系描述拆法 ✅、系统保留词 ✅）

---

## 八、分步执行顺序

```
Phase 1  包 schema 变更 + 包内测试
Phase 2  ~~迁移脚本验证 + 回填脚本开发~~（决策 7 取消）；改为新库端到端冒烟（§六.6）
Phase 3  文档同步 + 版本 bump 0.3.0 + 发版（沿用 0.2.0 流程）
（novel 旧库废弃清空 + 引擎适配 + 前端适配 = 后续专项，不在本次）
```

---

## 九、开放问题（2026-08-08 拍板后：①②③ 已消解，仅剩 ④）

| # | 问题 | 状态 |
|---|---|---|
| 1 | 关系 label 归位映射 | ✅ 消解（决策 7：存量废弃，无需映射表；新库直接按规则集 12 枚举 + located_in 写入，world-tools 提示词对齐属引擎专项） |
| 2 | property 中文化映射 | ✅ 消解（同上；新库直接按规则集词表写入） |
| 3 | aliases 存量来源 | ✅ 消解（无需回填；已发现 alias-index.json 本可为来源，随库一并废弃） |
| 4 | name 快照同步 | ⏳ 保留待确认：birth 写入 + 改名 change 事件同步 Entity.name（候选：与 updateEntitySummary 同模式）；**aliases 快照的维护归属（包内同步 vs 引擎侧维护）需拍板** |

---

## 十、风险与注意

1. **旧库废弃执行顺序**：清空 `.pi/world-graph-v3/` 必须在引擎升级 0.3.0 的专项中执行，执行前确认无未入库的创作内容；包发版（本次）不碰 novel 目录。
2. **事件日志随库清空**：旧 events.jsonl 一并废弃（决策 6/7），新日志从 0 开始，无新旧混排问题。
3. **ID 全新生成**：新库 declarationId/relationId 以中文 property/label 生成；旁车文件（chapter-index/alias-index）已验证不持久化节点 ID，无存量引用污染面。
4. **schema_hash 锁**：可见性 state 字段（D6）本次仍不动，维持"下次 schema 大改一并清理"的既定策略。
5. 剩余开放问题（§九.4）拍板后即可进入 Phase 1。
