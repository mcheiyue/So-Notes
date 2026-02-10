## [v1.1.7] - 2026-02-10

### 🚀 优化 (Optimizations)
*   **MiniMap 深度重构 (Performance)**
    > 彻底重写了 MiniMap 的渲染逻辑。通过引入原子化组件 (`MiniMapNoteItem`) 和 `React.memo` 防线，成功解决了拖拽笔记时导致的 O(N) 全量重绘问题。现在即使有上千个笔记，拖拽也丝般顺滑。
*   **视口拖拽零延迟 (Zero-Latency Drag)**
    > 针对 MiniMap 的视口红框实现了“直接 DOM 操作 + RAF 节流”的双轨更新机制。消除了因 React 渲染循环导致的“不跟手”和滞后感。
*   **Canvas 平移节流**
    > 将画布的视口平移逻辑从高频 React 更新中解耦，改用 `requestAnimationFrame` 循环驱动，显著降低了主线程负载。

### ✨ 新特性 (Features)
*   **快捷键系统 (Shortcuts)**
    > 引入了全新的快捷键管理器，支持以下高频操作：
    > *   `Delete` / `Backspace`: 删除选中笔记
    > *   `Ctrl + A` (Mac: Cmd + A): 全选当前看板笔记
    > *   `Ctrl + D` (Mac: Cmd + D): 创建选中笔记的副本
    > *   `Ctrl + 0` (Mac: Cmd + 0): 重置视口位置

### 🧹 清理 (Cleanup)
*   **Store 订阅优化**: 全面应用 `useShallow` 进行细粒度状态订阅，消除了父组件因无关状态变化产生的无效重绘。
