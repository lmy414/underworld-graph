# 设计评审记录（2026-08-02）

> 状态：**已记录，暂缓修复**。本文件是 v0.1.0 设计评审的存档，供后续排期修复时参考。
>
> 决策背景：underworld-graph 目前被 narrative-engine（及 novel 工程）直接消费，API / 数据语义
> 的任何改动都会牵动下游大面积修改。为避免在 0.1.0 阶段破坏消费方，评审结论先落档，
> 修复另行排期，且**每项修复前必须与 narrative-engine 消费方对齐**。

## 评审结论

领域模型设计合理：validFrom/validTo 承载故事时间轴，TypeGraph recorded 坐标承载事务时间轴，
JSONL 承载因果审计日志，可见性 / 知识持续语义清晰。工程化程度良好，可作为 0.1.0 独立包使用。

已实际验证：

- `npm test`：59/59 通过
- `npm run typecheck`：通过
- `dist/` 已构建；CI（Node 20/22 + typecheck + build + test + publish 门控）存在

主要短板集中在：**写入侧数据完整性**、**storyTime 排序语义**、**全表扫描性能**。

## 待修复清单

### P1（正确性，优先）

1. **写入无幂等 / ID 冲突风险**
   - 现状：ID 按约定生成（`decl-{entityId}-{property}-{storyTime}`、`rel-...`、
     `vis-{characterId}-{declarationId}-{validFrom}`），库不查重、不幂等、不报业务错误。
   - 触发场景：同一 storyTime 内同一属性多次 change、重复 birthEntity、
     `inferVisibility` 重复执行。
   - 建议方向：写入前唯一性检查；对已存在的 ID 显式抛错或提供 upsert 语义；补幂等测试。

2. **无引用完整性 / 区间校验**
   - 现状：Fact.entityId、Relation.source/target、Visibility.declarationId 不校验引用
     是否存在；validFrom > validTo 的倒置区间可被静默写入（retcon 闭合旧声明时可能产生）。
   - 建议方向：写入时校验引用；写入 / 闭合时校验区间；倒置时明确报错或按 retcon 语义处理。

3. **JSONL 日志与 SQLite 状态无原子性**
   - 现状：processEvent 先 append JSONL，再逐条写 store；birthEntity / killEntity 为多步写。
     中途失败会出现日志有、状态没有，或实体 / 事实半更新。无事件重放 / 对账机制。
   - 建议方向：多步写包事务（store 侧事务）；明确失败时的日志语义（回滚或标记）；
     评估事件重放能力。

4. **storyTime 用字符串字典序比较**
   - 现状：`validFrom <= storyTime < validTo` 为纯字符串比较；"act1-scene10" 会排在
     "act1-scene2" 之前。现有测试均使用零填充时间戳（如 `ch001.ev001`），掩盖了问题。
   - 建议方向：storyTime 归一化 / 格式校验（强制零填充或可排序编码），或引入排序键。

### P2（设计 / 性能 / 一致性）

5. **"Infinity" 字符串哨兵重复定义**
   - 现状：`world-graph.ts` 与 `character-view.ts` 各维护一份 `"Infinity"`；
     任何忘记特判的路径会因 `'I' < 'a'` 得到错误结果。
   - 建议方向：导出常量（或改为不可能与真实 storyTime 冲突的编码），统一处理。

6. **全表扫描是系统性性能瓶颈**
   - 现状：所有查询走 `find()` 全量 + JS filter；`getAllEntities` 为 N+1 查询；
     `updateFactEmbedding` 每次全扫（代码注释已承认）；`characterView` 为 D x V 双层循环。
   - 建议方向：用 TypeGraph `query()` / 索引替代全扫；先做基准测试确定量级。

7. **"图"语义未落地**
   - 现状：定义了 `declares` 边（Entity→Fact）但从不创建 / 查询；Relation 也是节点。
     本质是四张表 + 一条未使用的边。
   - 建议方向：明确定位——若做知识图谱则改用边并支持遍历；若只是状态库则删除边定义。

8. **API 一致性缺口**
   - `recordedAsOf` 支持不齐：getEntityHistory / getRelationHistory /
     getVisibilityForDeclaration / inferVisibility 不支持，同类查询支持。
   - `valueText` 在 getEntityAt / getAllDeclarations* 输出中被丢弃，但 schema 与 fulltext
     索引用它。
   - birth 事件 newFacts 的 modality 被硬编码为 "fact" 丢弃。
   - killEntity 只级联关闭 Fact，不关 Relation；死亡实体仍出现在关系查询与
     located_in 推断中（可能是有意设计，需要文档明确）。
   - updateEntitySummary 不写事件、不触发重新嵌入，与 reembedAll 注释的预期未接上。

### P3（工程细节）

9. 大量 `any` / `as unknown as EmbeddingValue`，削弱类型保证。
10. 无并发控制：processEvent 为多步异步操作，并发调用可能交错。
11. 事务时间有两套钟：SDK `r1:...` 坐标（recordedAsOf 用）与 EventRecord.recordedAt 墙钟，
    二者不保证对齐。
12. `migrate()` 实际只做 TypeGraph schema 版本迁移；README "migrate legacy db schema"
    的说法略夸大，真实数据迁移在 novel-importer。
13. 全部地基依赖 `@nicia-ai/typegraph`（小众 SDK）：需锁定版本并预演升级路径。
14. GPL-3.0-only 作为库许可证会限制闭源消费方，需确认是有意选择。

## 测试覆盖缺口（后续补测时对照）

- 重复 ID / 幂等
- 无效区间（validFrom > validTo）
- 部分失败 / 原子性
- 死亡实体的关系查询行为
- 非零填充 storyTime 排序
- 并发交错
- 事件日志损坏
- 跨进程重启持久化

## 修复前置约束

- 修复前与 narrative-engine / novel 消费方对齐，避免破坏现有调用。
- 涉及公共 API 的改动需走版本化策略（新增方法 / 可选参数优先，删除 / 改语义次之）。
- 每项修复需配套测试，并保持 `npm test` 与 `npm run typecheck` 全绿。

