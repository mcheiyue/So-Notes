# 拆分 Store、持久化服务化与交互引擎实例化

为降低 `useStore.ts` 与 `Canvas.tsx` 的耦合与复杂度，并为后续扩展（更复杂的撤销/重做、更多交互、潜在多窗口）提供可演进的边界，我们决定在 v1.4.0 进行架构收敛：将 Zustand 状态按 **Domain / Viewport / UI** 拆分；将 WAL/磁盘双源仲裁与自动持久化迁入独立 **StorageService**（订阅 Domain、WAL 节流 + 磁盘防抖，并提供 `flushPersistNow()`）；将 Canvas 的交互逻辑改为 **hooks + engine 实例**，并确立“拖拽真相在 engine 内存坐标，DOM 仅渲染”的原则。

## Considered Options

- 保持单一 store + 在各 action 内显式调用 `saveToDisk()`：实现简单，但持久化调用点分散（约 40 处）、副作用混入 store，难以测试与演进。
- 继续持久化 `ViewMode`（BOARD/TRASH）：更“记住用户位置”，但会造成重启后停留在 TRASH 的惊讶与只读视图粘滞；且与“UI state 不持久化”边界冲突。
- 交互引擎做全局单例：接入简单，但生命周期无边界，易产生未来多画布/多窗口的状态串扰，测试隔离困难。

## Consequences

- `StorageData` 收敛为仅包含 **Domain**，并新增 `schemaVersion` 与 `storageUpdatedAt` 以支持迁移与双源仲裁；旧数据中的 UI/Viewport 字段将被忽略，应用启动默认进入 **BOARD**。
- `switchBoard`、导入/清空等跨层动作将提升到 Controller/用例层编排，Domain/Viewport/UI 各自保持职责单一。

### 实际落地差异（v1.4.0 Commit 16-18）

- **appController** 已接管快捷键、全局菜单与切板/启动/导入等跨层用例入口，但内部仍通过旧 `useStore.getState()` 读写状态；旧 `useStore` 仍是过渡期写入主路径。
- **Canvas 交互引擎** 已引入每 Canvas 实例的 `CanvasEngine` 与 `useCanvasGlobalListeners`，Canvas 组件内的全局监听与 RAF 循环已迁出；sticky drag 落位不再从 DOM `style.transform` 反推，而以 engine 内存坐标为交互真相。
- **旧 `useStore.ts` 未删除**：Commit 07 删除门槛尚未满足，仍有控制器、Canvas 引擎、组件与测试依赖旧 store；`legacyDomainBridge` 继续负责旧 `useStore` → `domainStore` 的单向镜像。
- **后续删除前提**：appController、CanvasEngine 与仍直接引用旧 store 的组件完成迁移后，才能删除旧 `useStore.ts`、桥接层与对应测试路径。
