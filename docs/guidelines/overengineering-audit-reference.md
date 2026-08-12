# So-Notes 过度工程审计参考

> **状态**：活文档（open）  
> **用途**：代码规范 + 后续版本规划的复杂度债登记册  
> **栈**：Tauri v2 + React 19 + Zustand + Rust 桌面便签  
> **验证日**：2026-07-28（代理实测）  
> **归档条件**：下列暴露项全部 `closed`，或 `deferred` 且写明去向版本后，可移至 `docs/archive/`。未满足前禁止归档。

---

## 1. 状态 / 用途 / 何时归档

| 项 | 说明 |
| --- | --- |
| 当前状态 | `open`：复杂度债未清零 |
| 用途 | PR 强制规则；版本规划关闭复杂度项时的权威台账 |
| 谁维护 | 关闭任一项时同步回写「台账表」状态字与变更记录 |
| 归档 | 全部 closed / deferred（有去向）→ 移到 `docs/archive/` |

---

## 2. 范围

**仅覆盖**：过度工程与复杂度（可砍代码、半迁移、死代码、无门控诊断、生成物入库、巨石、化妆依赖）。

**不覆盖**（走正常审查/规划）：

| 类别 | 去向 |
| --- | --- |
| 正确性 / 功能回归 | 常规 QA / 单测 |
| 安全（SSRF、凭据等） | `docs/plans/v1.6.1-to-v1.7.0-planning-recommendations.md` 等安全主题 |
| 性能（画布卡顿、发布体积） | 性能包 / 体积门禁，不单为 LOC 开主题 |

---

## 3. 验证结论摘要（2026-07-28）

| 结论 | 说明 |
| --- | --- |
| 主体属实 | 双轨 store、死代码、常开 profiling、巨石、生成物入库、`*_MODULE` 脚手架等可复核 |
| 「11 层」偏夸 | backup 前端为网状协作，非严格 11 级调用栈 |
| 薄层 PARTIAL | `DataTransferService` / `PersistenceFacade` / `appController` **有真实编排**，非纯 thin，禁止整层误删 |
| 勿误判 | `react-draggable` 在用；`confirmStore` 与 `quitConfirmStore` **禁止合并** |

---

## 4. 规模基线（实测）

路径相对仓库根。行数为 2026-07-28 快照，后续以再测为准。

| 范围 | 规模 |
| --- | --- |
| `src/` 生产 | ~20543 行 |
| `src/` 测试 | ~29467 行 |
| Rust（`src-tauri`） | ~17642 行 |
| `docs/plans/` | 27 文件，~14504 行 |
| `src/components/BoardDock.tsx` | 非空 ~3221 / 物理 ~3438 |
| `src/store/useStore.ts` | 非空 ~2382 / 物理 ~2739 |
| `src-tauri/src/webdav/`（原单文件已拆） | 叶模块 8 生产 rs + tests；原 ~8538 行已分治 |
| `src-tauri/src/backup.rs` | 物理 ~5691 |
| backup 前端（`src/services/backup/` 等，11 文件） | ~2938 非空 |

---

## 5. 发现清单（按可砍量排序）

标签：`delete` | `stdlib` | `native` | `yagni` | `shrink`

### 5.1 可砍优先

| # | 标签 | 一行结论 | 展开 |
| --- | --- | --- | --- |
| 1 | **yagni / shrink** | Store 双轨半迁移：finish 或 rollback | **主写**：`src/store/useStore.ts`。**domain 写**几乎仅经 `src/store/legacyDomainBridge.ts` 的 `replaceDomainState`。**ui / viewport** 与主 store 双向同步。禁止永久半迁移；二选一完成真相源。 |
| 2 | **delete** | `DetachedNoteOverlay` 死代码 | `src/components/DetachedNoteOverlay.tsx`（~274）+ `DetachedNoteOverlay.test.tsx`（~752）。生产无 import（仅测试自引）。撕下便签已走 Tauri 独立窗，可删组件与测。 |
| 3 | **yagni** | FPS/diagnostics 生产常开 | `src/App.tsx` 调用 `useFPSMonitor` 启停。`ENABLE_PROFILING`（见 `vite.config.ts`）**不门控**采集。`DiagnosticsPanel` 挂在设置路径（`BoardDock`）。生产路径应收口到门控或开发态。 |
| 4 | **delete / yagni** | `CanvasWithProfiler` 空 `useFPSMonitor()` | `src/components/Canvas.tsx` 中 `CanvasWithProfiler` 仅再调一次 `useFPSMonitor()`，无实质 profiler 包装，噪音。 |
| 5 | **delete** | `test-results.json` 被 git 跟踪 | 根目录 `test-results.json`（~421KB）。生成物，应 untrack + ignore。 |
| 6 | **delete / yagni** | `*_MODULE` / `storageServiceScaffold` 无业务消费 | 例：`LEGACY_DOMAIN_BRIDGE_MODULE`、`DOMAIN_STORE_MODULE`、`VIEWPORT_STORE_MODULE`、`UI_STORE_MODULE`、`DATA_TRANSFER_SERVICE_MODULE`、`STORAGE_SERVICE_MODULE`；`StorageService` 内 `storageServiceScaffold`。仅标识字符串，无运行时业务消费。新代码禁止再加。 |

### 5.2 巨石与分层（后置）

| # | 标签 | 一行结论 | 展开 |
| --- | --- | --- | --- |
| 7 | **shrink** | `BoardDock` 巨石 | `src/components/BoardDock.tsx`（非空 ~3221）。UI/设置/诊断等堆叠；拆分按真实边界，不为 LOC 美学单独开版。 |
| 8 | **shrink** | `useStore` 巨石 | `src/store/useStore.ts`（非空 ~2382）。与 #1 绑定：先定真相源，再谈切分。 |
| 9 | **shrink** | `webdav/` 已拆分 / `backup.rs` 仍巨体 | **webdav**：v1.6.5 已拆为 `webdav/` 目录叶模块（types/error/ssrf/credential/config/transport/ops + tests），**已拆分**。**backup.rs**（~5691）仍 open。 |
| 10 | **shrink** | backup 前端多层（网状，非 11 级栈） | `src/services/backup/` 约 11 个生产模块（Coordinator / Runner / Retention / WebDAV / 计划任务 / ActivityLog 等）网状协作。「11 层」表述偏夸。 |

### 5.3 薄层与误判（PARTIAL / 禁止）

| # | 标签 | 一行结论 | 展开 |
| --- | --- | --- | --- |
| 11 | **PARTIAL** | 三处 facade 有编排，勿整层删 | `src/services/transfer/DataTransferService.ts`、`src/services/storage/PersistenceFacade.ts`、`src/controllers/appController.ts`。有真实编排与测试替换点；新代码优先直接调用，已有 facade 仅在有测试替换价值时保留。 |
| 12 | **yagni** | `docs/plans` 历史堆积 | 27 文件 ~14504 行。**chore 归档**，非版本主主题。 |
| 13 | **stdlib** | `clsx` + `tailwind-merge` via `cn.ts` | `src/utils/cn.ts`。化妆依赖，低优先；无痛时可不碰。 |
| 14 | **禁止** | `confirmStore` vs `quitConfirmStore` | `src/store/confirmStore.ts` 与 `src/store/quitConfirmStore.ts` 语义不同（通用确认 vs 退出确认）。**禁止合并**。 |
| 15 | **禁止误判** | `react-draggable` 在用 | `NoteCard.tsx` 等使用 `DraggableCore`。**非死代码**，勿删依赖。 |

---

## 6. 代码规范（强制，后续 PR）

1. **半迁移禁止永久化**：双轨 store 必须 **finish** 或 **rollback**，不得长期双写/双向同步。
2. **禁止新增第三写真相源**：领域状态只允许一个权威源。
3. **生产路径禁止无门控常开 profiling / rAF 诊断**：采集须 `ENABLE_PROFILING`（或等价）门控，或仅开发态。
4. **禁止 git 跟踪生成物**：如 `test-results.json`；应 ignore，不入库。
5. **禁止为 LOC 美学单独开版本主主题**：巨石拆分仅作附带或明确结构债版本，且有可验证边界。
6. **薄 facade 仅在有测试替换点时保留**；新代码优先直接调用实现。
7. **禁止合并** `confirmStore` 与 `quitConfirmStore`。
8. **新代码禁止再加** `*_MODULE` 字符串脚手架与无消费者 scaffold。

---

## 7. 建议清理顺序（ponytail）

```
死代码 / 生成物
  → profiling 门控（含 CanvasWithProfiler 噪音）
  → store 真相源二选一（finish 或 rollback）
  → 巨石 / backup 分层后置（不为美学抢主主题）
```

| 阶段 | 项 | 理由 |
| --- | --- | --- |
| 1 | #2 #5 #6 #4 | 零行为风险或仅删噪音 |
| 2 | #3 | 生产路径止血 |
| 3 | #1（连带 #8） | 复杂度根因；先定 SSOT |
| 4 | #7 #9 #10 #12 #13 | 后置；#11 只收紧用法不整删 |

---

## 8. 与版本规划的关系

| 角色 | 路径 |
| --- | --- |
| 版本主题与安全/体验债 | `docs/plans/v1.6.1-to-v1.7.0-planning-recommendations.md` |
| **复杂度债登记（本文件）** | `docs/guidelines/overengineering-audit-reference.md` |

规则：

- 本文件是 **复杂度债** 权威台账；规划关闭对应项时 **回写** 本文件状态字（`open` / `closed` / `deferred`）与去向版本。
- 不为 LOC 单独开主主题；与规划冲突时，安全/正确性优先于砍复杂度。
- `docs/plans` 历史稿归档属 chore，不占用产品版本主叙事。

---

## 9. 台账表

| 项 | 标签 | 状态 | 建议去向版本 | 关闭条件 |
| --- | --- | --- | --- | --- |
| #1 Store 双轨半迁移 | yagni/shrink | open | 结构债窗口（与 useStore 同轨） | 单一真相源；legacy 桥退役或明确 rollback 完成 |
| #2 DetachedNoteOverlay 死代码 | delete | open | 任意 chore / 附带 | 组件+测试删除；无生产引用 |
| #3 FPS/diagnostics 常开 | yagni | open | 性能或 chore 附带 | 生产采集有门控；设置页诊断不默认热路径常开 |
| #4 CanvasWithProfiler 噪音 | delete/yagni | open | 与 #3 同批 | 去掉空包装或并入门控路径 |
| #5 test-results.json 入库 | delete | open | chore 立即 | untrack + `.gitignore` |
| #6 *_MODULE / scaffold | delete/yagni | open | chore 附带 | 删除无消费者常量；规范禁止新增 |
| #7 BoardDock 巨石 | shrink | open | 有意后置 | 按真实 UI 边界拆分且有测试；非纯 LOC |
| #8 useStore 巨石 | shrink | open | 依赖 #1 | SSOT 完成后按域切分 |
| #9 webdav/backup.rs 巨体 | shrink | partial | webdav=v1.6.5 已拆分；backup 仍 deferred | webdav 目录叶模块已落地；backup.rs 边界与外置测仍 open |
| #10 backup 前端网状 | shrink | open | deferred | 职责文档化或必要合并；不追求「层数」 |
| #11 三 facade PARTIAL | PARTIAL | open | 用法收紧，非整删 | 新代码直连；旧 facade 仅保留有 mock 点者 |
| #12 docs/plans 堆积 | yagni | open | chore 归档 | 历史计划移 archive 或索引收敛 |
| #13 clsx+twMerge/cn | stdlib | open | 低优先 | 无痛可留；替换须零行为差 |
| #14 confirm vs quitConfirm | 禁止合并 | closed（规范） | — | 规范已写死；违规 PR 拒 |
| #15 react-draggable | 禁止误判 | closed（澄清） | — | 保持依赖；勿当死代码删 |

状态字：`open` | `closed` | `deferred`（deferred 必须填「建议去向版本」）。

---

## 10. 变更记录

| 日期 | 变更 |
| --- | --- |
| 2026-07-28 | 初版：合并 ponytail 过度工程审计验证结论；活文档，债清后归档 |

---

*关闭任一项时：改台账状态 → 必要时改「建议去向」→ 追加变更记录一行。全文保持简体中文；路径与代码标识保持仓库原样。*
