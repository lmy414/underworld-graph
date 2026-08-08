# 字段语义与命名约定讨论记录（2026-08-07）

> 背景：0.2.0 全量修复（B5/C1-C4/D1-D5/D7/D8）提交前，围绕"字段实际口径 / 命名语言混用 /
> 关系信息到达角色"进行的一轮核对与讨论。本文档固化核对结论与讨论决策状态。
> 相关台账：DEPLOYMENT.md §9；相关 commit：b8bd4d6（0.2.0）。

## 1. 数据模型全貌（4 类节点 + 1 条日志）

| 类别 | 职责 | 字段 | 描述字段 |
|---|---|---|---|
| Entity（实体） | 存在谁（身份证） | entityId / type / name / aliases / validFrom / validTo / embedding | `summary`（独立字段，参与向量检索、注入角色上下文）；0.3.0 起 +name/aliases 展示快照 |
| Fact（状态声明） | 什么样（实体内涵的最小单元） | entityId / property / description / modality / validFrom / validTo / embedding | `description`（0.3.0 起 value/valueText 退场） |
| Relation（关系） | 和谁有关（实体间连接） | relationId / sourceId / targetId / label / description / validFrom / validTo | 0.3.0 起 +description（叙事描述），label 收窄为简单类型词 |
| Visibility（可见性） | 哪个角色知道哪条声明 | characterId / declarationId / state(恒"known") / confidence / source / isExplicit / 时态 | — |
| EventRecord（JSONL 日志） | 一切变更的因果审计 | eventId / type / storyTime / entityId / source / entityType / summary / invalidated / newFacts / causedBy / userInput / recordedAt | — |

**Fact 的本质**：一条带故事时间有效期的声明——"从 validFrom 起，某实体的某 property
是某描述内容，认识论地位为 modality"。状态变化 = 闭旧开新，旧声明永不删除。
由此获得：时间旅行查询、历史可溯（曾用名/旧状态）、retcon 隔离（recordedAsOf）、
角色认知（belief/hypothesis 与客观 fact 并存）。

### Fact 真实样本（novel 库，0.3.0 起 description 契约）

```json
{ "declarationId": "decl-ent_char_f5faee40-名字-ch001.ev001",
  "entityId": "ent_char_f5faee40", "property": "名字", "description": "酒寄彩叶",
  "modality": "fact", "validFrom": "ch001.ev001", "validTo": "Infinity" }
```

## 2. 关键字段口径（以代码为准，0.3.0 后）

- **Entity.name 展示快照**（0.3.0 起）：显示名直读 `Entity.name`，不再依赖
  `properties.名字 || entityId` fallback 链；快照非权威——改名历史/可见性/检索仍由
  `property="名字"` 的 Fact 承载；birth 提取「名字」property 写入，改名 change 事件
  自动同步（与 updateEntitySummary 同模式）。aliases 快照由引擎侧维护（缺省 []）。
- **recordedAt**（D8 后）：缺省 = SDK recorded 坐标（`r1:...`，取本事件提交前最近提交点）；
  空图首写不落；旧日志为 ISO 墙钟，新旧混排为已知事实；显式传入优先。
- **EventRecord.summary**：birth 事件填实体描述；D5 起 summary 变更事件复用此字段。
- **invalidated[].property**：0.2.0 前为死字段；0.2.0 起 strict 模式下与声明实际
  property 做一致性校验（非 strict 保持忽略）。
- **description**：0.3.0 起状态内容唯一载体（searchable zh，进全文索引），全部公开
  输出路径形状统一（E1 关闭）；旧 value/valueText 键不做兼容（决策：不兼容旧数据）。
- **Visibility.state**：恒 "known"，单值枚举无语义（D6，暂缓至 schema 大改）。
- **confidence / isExplicit**：写入侧有意义（experienced=1、显式/推断），查询侧不消费。
- **strict**（C4）：仅 processEvent/写入方法输入侧校验开关，parse 前剥离，不落日志。

## 3. ID 生成约定

| ID | 规则 | 备注 |
|---|---|---|
| entityId | 无库层校验；两种形态并存：`ent_char_<hex8>`（import-card 代码生成）/ `ent_char_yui`（LLM 语义 slug） | 工具 schema 无 pattern |
| eventId | 消费方工具 schema 强制 `^evt_[A-Za-z0-9_.-]+$` | 0.2.0 库内 summary 事件已统一为 `evt_summary_...` 前缀 |
| declarationId | `decl-{entityId}-{property}-{storyTime}`；0.2.0 起同批同 (entityId,property) 次条加 `-2`/`-3` | property 语言进入 ID |
| relationId | `rel-{src}-{label}-{tgt}-{storyTime}` | **label 进入 ID** |
| visibilityId | `vis-{characterId}-{declarationId}-{validFrom}` | 间接受 property 语言影响 |

## 4. 数据层语言现状（novel 库实测，2026-08-07）

- **规则集口径**（角色规则集.md:20-38）：state_changes.property 必须用中文词表
  （心情/当前行动/位置…），明文禁止英文 mood/location/name；信念格式
  `信念.关于_{对象}.{方面}`；关系 label 中文 12 词枚举（仇敌/朋友/师徒/结义/恋人/
  上下级/亲属/同盟/敌对/认识/邻居/同事），`located_in` 为保留英文关键词。
- **实际数据**：Fact property 99% 英文（mood×43、current_action×33、name×30…）——
  全是规则集明令禁止的旧数据；belief 四条四不像（`belief.about_辉夜.印象` 中英混排）。
- **Relation label 两套风格**：英文短枚举（related_to/located_in/knows/owns/family_of
  /game_acquaintance，约 22 条）vs 中文叙事长句（约 58 条、~50 个唯一值，多一次性）。
- **实体名字覆盖**：存活实体 29/29 均有 live name Fact（27 中文 + KASSEN/BAMBOOcafe
  两个专名），可视化中退化成英文 ID 的场景 = 关系对端不在当前 storyTime 实体集
  （已退场/历史），非数据缺 name。
- **closeRelation 实际坏死**：label 精确等值匹配，中文长句无法复现 →
  80 条关系全部 validTo=Infinity，从无成功闭合。

## 5. 角色上下文注入内容（packages/role-pool/src/prompts.ts 实测）

- system prompt：角色规则集 + 静态/动态冲突提醒 + executionHints
- user message：你的 entityId + 本场角色名单 → 角色卡静态层 JSON → 动态层
  dynamicFacts（可见性五步过滤后的 Fact，`- [属主] property: value（modality）`，
  已闭合标"旧"）→ 故事时间 → 先动者公开 action（隔离 thought/emotion/state_changes）
  → 事件指令（末尾）

**核心发现：Relation 边无任何注入通道**（cast 仅 staticCard + dynamicFacts），
角色 LLM 不知道关系图中存在的关系。佐证：DB 中存在 property="relationship" 的
Fact×4 —— 关系信息实际靠 Fact 流通。中文长句 label 的真实消费方只有
人类（可视化）与 scheduler LLM（若主动查 relations）。

## 6. 讨论过的方案与决策状态（2026-08-08 字段补全后更新）

| 议题 | 方案 | 状态 |
|---|---|---|
| 关系 label 与描述分离 | 拆法 2：label 中文枚举化（标识/匹配键）+ 长句描述迁 Fact（`关系.关于_{对象}` 命名空间，自动获得可见性/注入/检索） | ❌ **用户不接受**（2026-08-07），顾虑：Fact 表混乱、模型对称性 |
| 同上 | 拆法 1：Relation schema 加 description 字段 | ✅ **0.3.0 已落地**（2026-08-08）：Relation +description，label 收窄为简单类型词（closeRelation/ID 可复现）；"改 schema_hash 触发 MIGRATION_ERROR"顾虑由"不兼容旧数据、存量废弃从 0 开始"决策化解 |
| 关系到达角色 | A 纯 Fact 通道 / B cast 加 relations 字段 / C 两者结合 | 未拍板（引擎适配专项再议） |
| 可视化中英混排 | ①名字解析改历史全量 ②显示层 label/property 映射表 ③数据层迁移 | ③✅ 0.3.0 落地（name/aliases 快照 + property 中文词表）；①② 随存量废弃不再需要（前端适配专项直读 Entity.name） |
| property 中文词表落地 | import-card 英文 key、world-tools 示例改中文词表；存量 189 条英文 Fact 迁移与否 | ✅ 0.3.0 拍板：词表随新库从 0 执行（引擎适配专项改写入侧）；存量不迁移（决策⑦废弃） |
| 系统保留词 | 候选约定：name / located_in 等系统保留词用英文，业务词用中文词表 | ✅ 0.3.0 拍板：`located_in` 保留英文；名字业务词用「名字」（NAME_PROPERTY 约定） |

### E 类待对齐议题（已登记 DEPLOYMENT.md §9.4）

- E1：valueText 输出裁剪不一致（getEntityHistory 含、getEntityAt/getAllDeclarations* 不含）→ ✅ 0.3.0 已修（value/valueText 整体退场）
- E2：invalidated[].property 死字段（0.2.0 已部分激活：strict 一致性校验）
- E3：Entity.summary 与 Fact property="summary" 双轨并存

## 7. 0.2.0 发布状态

- commit b8bd4d6（master，**未推送**）：12 项修复 + 97 tests 全绿 + 文档同步。
- npm 发布：用户决定暂缓，发布时再要 NPM_TOKEN（CI tag 推送触发，或本地
  `npm publish --access public`）。
- 消费方 narrative-engine 当前依赖 `^0.1.2`，0.2.0 含破坏性变更（updateEntitySummary
  三参、traceCauses 可空返回、birth newFacts 语义），升级时需同步适配：
  world-tools 的 updateSummary 调用补 storyTime、traceCauses 判空、
  工具描述文案更新（summary"纯展示"承诺已变）。
