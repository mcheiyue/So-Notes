# v1.3.1 - 性能基线与诊断

**预计工作量：** 3-4 天  
**排期位置：** 必须早于状态结构重构和批量操作  
**核心目标：** 先量化问题，再决定重构边界；不凭感觉优化。

---

## 0. 现状评估

### 现有能力

| 维度     | 现状                         | 可复用点                                   | 缺口                                              |
| -------- | ---------------------------- | ------------------------------------------ | ------------------------------------------------- |
| **测试数据** | 无统一工厂，测试文件内联构造 | `makeNote`/`makeBoard` 样例可复用              | 缺少规模样本生成器（100/500/1000/3000条）         |
| **性能监控** | 无监控实现                   | 保存状态机（`saveStatus`/`lastSavedAt`）可扩展 | 缺少 `performance.now()` 埋点、耗时统计、慢路径日志 |
| **诊断面板** | 无独立面板                   | `BoardDock` 数据管理区可扩展                 | 缺少便签统计、性能指标展示                        |
| **开发日志** | 少量 `console.log`             | `Canvas`/`App` 有少量调试输出                  | 缺少体系化 debug output                           |

### 关键问题（来自 `问题.md`）

#### ❌ 错误方案：用 `performance.now()` 包裹函数
- **问题**：React 的状态更新是异步且批处理的，同步时间戳只测量 JS 执行时间
- **不包含**：React 调和（Reconciliation）和 DOM 绘制（Commit）耗时
- **修正**：必须使用 `<React.Profiler>` API 和 User Timing API

#### ❌ 错误方案：诊断数据进入 Zustand
- **问题**：高频指标进入 Store 会触发无意义的 React 重渲染
- **后果**：诊断面板本身成为性能瓶颈
- **修正**：诊断面板必须脱离 React 管线，用 `useRef` + Vanilla JS 直接 DOM 操作

#### ❌ 错误方案：3000 条便签直接 DOM 渲染
- **问题**：未实现画布虚拟化，DOM 节点爆炸
- **后果**：16ms 拖拽预算瞬间失效
- **修正**：先确保画布虚拟化 + 视口裁剪

---

## 1. 任务 A：固定规模性能样本

### 目标
建立可重复的本地测试数据集，用于衡量渲染、拖拽、搜索、保存和看板切换。

### A.1 创建测试数据工厂

**新建文件**：`src/test/fixtures/sampleData.ts`

```typescript
import { Note, Board, StorageData, DEFAULT_BOARD, DEFAULT_CONFIG } from '../../store/types';

// 核心接口
interface SampleConfig {
  noteCount: number;        // 便签数量
  boardCount: number;       // 看板数量
  scenario: 'dense' | 'sparse' | 'long-text' | 'trash-heavy';  // 场景类型
  textLength?: 'short' | 'medium' | 'long';  // 文本长度
}

// 导出函数
export function generateSampleNotes(config: SampleConfig): Note[];
export function generateSampleBoards(count: number): Board[];
export function generateSampleState(config: SampleConfig): StorageData;

// 预设样本
export const SAMPLE_PRESETS = {
  NOTES_100: { noteCount: 100, boardCount: 1, scenario: 'dense' },
  NOTES_500: { noteCount: 500, boardCount: 3, scenario: 'sparse' },
  NOTES_1000: { noteCount: 1000, boardCount: 5, scenario: 'sparse' },
  NOTES_3000: { noteCount: 3000, boardCount: 8, scenario: 'sparse' },
  LONG_TEXT: { noteCount: 100, boardCount: 1, scenario: 'long-text', textLength: 'long' },
  TRASH_HEAVY: { noteCount: 500, boardCount: 2, scenario: 'trash-heavy' },
};
```

**场景说明**：
- `dense`：单看板密集布局，便签间距 20px
- `sparse`：多看板分散布局，便签间距 100px
- `long-text`：长文本场景，每条便签 500-2000 字符
- `trash-heavy`：50% 便签在废纸篓

### A.2 画布虚拟化检查（带节流与外圈缓冲）

**前置条件**：在运行压力测试前，确保 `Canvas.tsx` 具备**节流后**的视口裁剪

**⚠️ 致命陷阱**：如果在每次 render 中直接 `notes.filter()`，平移时 O(N) 遍历会引发掉帧灾难

**修正方案**：

```typescript
// 1. 外圈缓冲配置
const VIEWPORT_BUFFER = 500; // 视口外扩 500px，减少重算频率

// 2. 节流后的 viewportRect（useMemo 依赖）
const viewportRect = useMemo(() => ({
  x: viewport.x - VIEWPORT_BUFFER,
  y: viewport.y - VIEWPORT_BUFFER,
  w: viewport.w + VIEWPORT_BUFFER * 2,
  h: viewport.h + VIEWPORT_BUFFER * 2,
}), [
  // 对 viewport.x/y 进行粗粒度取整，减少 re-render 频率
  Math.floor(viewport.x / 100) * 100,
  Math.floor(viewport.y / 100) * 100,
  viewport.w,
  viewport.h
]);

// 3. 视口内便签（O(N) 计算，但调用频率大幅降低）
const visibleNotes = useMemo(() => 
  notes.filter(note => 
    note.x >= viewportRect.x - NOTE_WIDTH &&
    note.x <= viewportRect.x + viewportRect.w &&
    note.y >= viewportRect.y - NOTE_HEIGHT &&
    note.y <= viewportRect.y + viewportRect.h
  ),
  [notes, viewportRect]
);
```

**关键设计**：
- **外圈缓冲**：视口向外延伸 500px，小幅度平移不会触发重算
- **坐标取整**：viewport.x/y 按 100px 取整，减少 memo 失效频率
- **useMemo 缓存**：只有真实数据变化或跨越整百边界时才重算

**后续优化（v1.4+）**：
如果数据量上探到 3000+，考虑在 Zustand 中引入 **四叉树（QuadTree）** 或 **空间哈希**，把 O(N) 查找降级为 O(logN) 或 O(1)

### A.3 独立耗时分离

**新增测试**：测量不同耗时来源

```typescript
interface PerformanceBreakdown {
  dataGenerationTime: number;    // 数据生成耗时
  ipcSerializationTime: number;   // IPC 序列化耗时
  renderTime: number;            // 渲染耗时
  ipcResponseTime: number;       // IPC 响应耗时
}
```

### A.4 创建样本生成测试

**新建文件**：`src/test/fixtures/sampleData.test.ts`

验证样本生成的正确性：
- 数量准确
- 字段完整
- 分布合理
- 可序列化

---

## 2. 任务 B：性能预算

### 目标
设定可验收的性能阈值，建立真实测量埋点。

### B.1 性能预算常量

**新建文件**：`src/constants/performance.ts`

```typescript
export const PERFORMANCE_BUDGET = {
  // 单便签拖拽：不得触发无关卡片级联重渲染
  DRAG_RENDER_TIME_MS: 16,  // 单帧预算
  
  // 搜索输入：不得造成明显卡顿
  SEARCH_TIME_MS: 100,      // 100ms 内返回结果
  
  // 保存链路：不得阻塞交互线程
  SAVE_TIME_MS: 500,        // 500ms 内完成保存
  
  // 看板切换：不得有明显延迟
  BOARD_SWITCH_MS: 200,     // 200ms 内完成切换
  
  // 初始化：冷启动时间
  COLD_START_MS: 1000,      // 1s 内完成加载
};

// 慢路径阈值
export const SLOW_PATH_THRESHOLD = {
  RENDER: 50,    // 渲染超过 50ms 标记为慢路径
  SEARCH: 100,   // 搜索超过 100ms 标记为慢路径
  SAVE: 500,     // 保存超过 500ms 标记为慢路径
};
```

### B.2 真实性能测量工具

**新建文件**：`src/utils/performance.ts`

```typescript
// React Profiler 测量
export function startReactProfiler(name: string): void;
export function endReactProfiler(name: string): React.ProfilerOnRenderCallback;

// User Timing API 测量
export function markStart(name: string): void;
export function markEnd(name: string): void;
export function getMeasurements(): PerformanceEntry[];

// FPS 监控
export function startFPSMonitoring(): void;
export function stopFPSMonitoring(): { 
  averageFPS: number; 
  minFPS: number; 
  maxFPS: number; 
  jankCount: number;  // 掉帧次数
};

// 高频数据收集器
export class PerformanceObserver {
  constructor(thresholds: { name: string; threshold: number }[]);
  observe(): void;
  disconnect(): void;
  getSlowEntries(): PerformanceEntry[];
}
```

### B.3 关键路径埋点

#### B.3.1 Canvas 组件真实渲染追踪

**修改文件**：`src/components/Canvas.tsx`

```typescript
import { Profiler } from 'react';

// 用 React.Profiler 包装组件
<Profiler id="Canvas" onRender={onCanvasRender}>
  {/* 画布内容 */}
</Profiler>

function onCanvasRender(
  id: string, // "Canvas"
  phase: "mount" | "update", // "update"
  actualDuration: number, // 实际渲染耗时
  baseDuration: number, // 基础渲染耗时
  startTime: number,
  commitTime: number
) {
  // 记录真实渲染耗时
  trackRenderMetric(id, actualDuration, commitTime - startTime);
  
  // 开发环境输出慢路径
  if (import.meta.env.DEV && actualDuration > SLOW_PATH_THRESHOLD.RENDER) {
    console.warn(`[慢路径] Canvas 渲染: ${actualDuration}ms`);
  }
}
```

#### B.3.2 Store 保存链路拆解（跨端时钟对齐）

**修改文件**：`src/store/useStore.ts`

前端测量往返总耗时：

```typescript
// 用 User Timing API 测量 IPC 耗时
async function saveToDisk(): Promise<boolean> {
  performance.mark('save-serialization-start');
  
  const stateData: StorageData = {
    notes: get().notes,
    boards: get().boards,
    currentBoardId: get().currentBoardId,
    config: get().config,
  };
  
  performance.mark('save-serialization-end');
  performance.measure('save-serialization', 
    'save-serialization-start', 
    'save-serialization-end'
  );
  
  performance.mark('save-ipc-start');
  
  // 发送数据到 Rust
  const result = await invoke<SaveResult>('save_content', { 
    data: stateData,
    generationId: get().saveGenerationId,
  });
  
  performance.mark('save-ipc-end');
  performance.measure('save-ipc', 'save-ipc-start', 'save-ipc-end');
  
  // 计算：IPC 开销 = 总耗时 - Rust I/O 耗时
  const totalDuration = performance.getEntriesByName('save-ipc')[0].duration;
  const ioDuration = result.io_duration_ms || 0;
  const ipcOverhead = totalDuration - ioDuration;
  
  console.log(`总耗时: ${totalDuration}ms, Rust I/O: ${ioDuration}ms, IPC开销: ${ipcOverhead}ms`);
  
  // ⚠️ 必须清理 Performance Timeline，防止长期运行内存泄漏
  performance.clearMarks('save-serialization-start');
  performance.clearMarks('save-serialization-end');
  performance.clearMarks('save-ipc-start');
  performance.clearMarks('save-ipc-end');
  performance.clearMeasures('save-serialization');
  performance.clearMeasures('save-ipc');
  
  return result.success;
}
```

**修改文件**：`src-tauri/src/persistence.rs`

Rust 侧自证清白：

```rust
use std::time::Instant;
use serde::Serialize;

#[derive(Serialize)]
pub struct SaveResult {
    pub success: bool,
    pub io_duration_ms: u64,  // 纯净的物理 I/O 耗时
    pub retries: u32,          // 锁重试次数
}

pub fn write_content(data: &str) -> SaveResult {
    let start = Instant::now();
    
    // 1. 获取锁
    // 2. 写临时文件
    // 3. fsync
    // 4. rename
    
    let io_duration = start.elapsed().as_millis() as u64;
    
    SaveResult {
        success: true,
        io_duration_ms: io_duration,
        retries: retry_count,
    }
}
```

**核心设计**：
- Rust 侧测量真实的文件系统操作耗时（fsync、rename）
- 将纯净 I/O 耗时随 ACK 返回前端
- 前端计算：**真实的 IPC 与序列化开销 = 前端 User Timing 总耗时 - Rust 返回的 io_duration_ms**
- 这样可以准确区分是 JSON 序列化阻塞了 JS 主线程，还是 Defender 锁死了文件系统

**⚠️ 关键：跨端类型契约**

必须在 TypeScript 侧显式定义 `SaveResult` 接口，并泛型约束 `invoke` 调用：

**修改文件**：`src/store/types.ts`

```typescript
// Tauri IPC 返回类型定义
export interface SaveResult {
  success: boolean;
  io_duration_ms: number;  // Rust 侧 I/O 耗时（ms）
  retries: number;         // 锁重试次数
}
```

**修改文件**：`src/store/useStore.ts`

```typescript
import { invoke } from '@tauri-apps/api/core';
import type { SaveResult } from './types';

// 泛型约束确保类型安全
const result = await invoke<SaveResult>('save_content', { 
  data: stateData,
  generationId: get().saveGenerationId,
});

// 类型安全访问
const ioDuration = result.io_duration_ms; // number | undefined 不会变成 undefined
```

**为什么必须显式定义？**
- Tauri IPC 底层是 JSON-RPC 通信
- Rust 侧的 `Serialize` 会自动序列化为 JSON
- 如果 TS 侧没有同步更新类型，解构 `result.io_duration_ms` 会拿到 `undefined`
- 导致 `NaN` 计算错误，诊断数据完全失效

#### B.3.3 高频交互监控

**修改文件**：`src/components/Canvas.tsx`

```typescript
// 拖拽时的 FPS 监控
useEffect(() => {
  if (!isDragging) {
    stopFPSMonitoring();
    return;
  }
  
  startFPSMonitoring();
  
  return () => stopFPSMonitoring();
}, [isDragging]);
```

---

## 3. 任务 C：轻量诊断面板

### 目标
扩展诊断信息展示，但严格脱离 React 管线避免性能干扰。

### C.1 独立诊断数据收集器

**新建文件**：`src/utils/diagnostics.ts`

```typescript
// 独立的诊断数据收集器，不依赖 Zustand
export class DiagnosticsCollector {
  private metrics = {
    totalNotes: 0,
    currentBoardNotes: 0,
    selectedNotes: 0,
    trashNotes: 0,
    
    lastSaveDuration: 0,
    lastSearchDuration: 0,
    lastInitDuration: 0,
    
    fps: 60,
    jankCount: 0,
  };
  
  private slowPaths: Array<{ 
    name: string; 
    duration: number; 
    timestamp: number 
  }> = [];
  
  // 直接更新数据，不触发 Store 更新
  updateMetric<K extends keyof typeof metrics>(
    key: K, 
    value: typeof metrics[K]
  ): void;
  
  // 获取当前数据
  getMetrics(): typeof metrics;
  
  // 记录慢路径
  recordSlowPath(name: string, duration: number): void;
  
  // 清除慢路径记录
  clearSlowPaths(): void;
  
  // 性能 Observer 设置
  private setupPerformanceObserver(): void;
}

// 全局单例
export const diagnostics = new DiagnosticsCollector();
```

### C.2 防弹容器：高频指标显示组件

**问题**：直接 `useRef.current.innerHTML` 会被 React 调和机制抹掉。

**解决方案**：创建极简、无 props、memo 锁死的组件：

**新建文件**：`src/components/DiagnosticsMetric.tsx`

```typescript
import React, { useRef, useEffect, forwardRef, useImperativeHandle } from 'react';

export interface DiagnosticsMetricHandle {
  setText: (text: string) => void;
}

// 防弹容器：不接 props，不会触发重绘
const DiagnosticsMetric = forwardRef<DiagnosticsMetricHandle>((_, ref) => {
  const spanRef = useRef<HTMLSpanElement>(null);
  
  useImperativeHandle(ref, () => ({
    setText: (text: string) => {
      if (spanRef.current) {
        spanRef.current.textContent = text;
      }
    }
  }));
  
  // 纯占位容器，内容通过 ref 外部写入
  return <span ref={spanRef} className="diagnostics-value" />;
});

// React.memo 锁死，父组件重绘不会触发子组件重绘
export default React.memo(DiagnosticsMetric, () => true);
```

**新建文件**：`src/components/DiagnosticsPanel.tsx`

```typescript
import { useEffect, useRef, createRef } from 'react';
import { diagnostics } from '../utils/diagnostics';
import DiagnosticsMetric, { DiagnosticsMetricHandle } from './DiagnosticsMetric';

export const DiagnosticsPanel = () => {
  // 为每个高频指标创建 ref
  const totalNotesRef = useRef<DiagnosticsMetricHandle>(null);
  const currentBoardNotesRef = useRef<DiagnosticsMetricHandle>(null);
  const selectedNotesRef = useRef<DiagnosticsMetricHandle>(null);
  const trashNotesRef = useRef<DiagnosticsMetricHandle>(null);
  const lastSaveRef = useRef<DiagnosticsMetricHandle>(null);
  const lastSearchRef = useRef<DiagnosticsMetricHandle>(null);
  const fpsRef = useRef<DiagnosticsMetricHandle>(null);
  const jankRef = useRef<DiagnosticsMetricHandle>(null);
  
  useEffect(() => {
    // 直接通过 ref 更新，完全绕过 React 渲染树
    const updateMetrics = () => {
      const metrics = diagnostics.getMetrics();
      
      totalNotesRef.current?.setText(`${metrics.totalNotes} 条`);
      currentBoardNotesRef.current?.setText(`${metrics.currentBoardNotes} 条`);
      selectedNotesRef.current?.setText(`${metrics.selectedNotes} 条`);
      trashNotesRef.current?.setText(`${metrics.trashNotes} 条`);
      lastSaveRef.current?.setText(`${metrics.lastSaveDuration}ms`);
      lastSearchRef.current?.setText(`${metrics.lastSearchDuration}ms`);
      fpsRef.current?.setText(metrics.fps.toFixed(1));
      jankRef.current?.setText(`${metrics.jankCount}`);
    };
    
    const interval = setInterval(updateMetrics, 1000);
    updateMetrics(); // 初始更新
    
    return () => clearInterval(interval);
  }, []);
  
  return (
    <div className="diagnostics-panel">
      <div className="diagnostics-section">
        <h3>便签统计</h3>
        <div className="metric-row">
          <span>总计:</span>
          <DiagnosticsMetric ref={totalNotesRef} />
        </div>
        <div className="metric-row">
          <span>当前看板:</span>
          <DiagnosticsMetric ref={currentBoardNotesRef} />
        </div>
        <div className="metric-row">
          <span>已选中:</span>
          <DiagnosticsMetric ref={selectedNotesRef} />
        </div>
        <div className="metric-row">
          <span>废纸篓:</span>
          <DiagnosticsMetric ref={trashNotesRef} />
        </div>
      </div>
      
      <div className="diagnostics-section">
        <h3>性能指标</h3>
        <div className="metric-row">
          <span>最近保存:</span>
          <DiagnosticsMetric ref={lastSaveRef} />
        </div>
        <div className="metric-row">
          <span>最近搜索:</span>
          <DiagnosticsMetric ref={lastSearchRef} />
        </div>
        <div className="metric-row">
          <span>FPS:</span>
          <DiagnosticsMetric ref={fpsRef} />
        </div>
        <div className="metric-row warning">
          <span>掉帧次数:</span>
          <DiagnosticsMetric ref={jankRef} />
        </div>
      </div>
    </div>
  );
};
```

**核心设计**：
- `DiagnosticsMetric` **不接任何 props**，父组件重绘不会导致子组件重绘
- 使用 `React.memo(() => true)` 彻底锁死比较函数
- 通过 `useImperativeHandle` 暴露 `setText` 方法供外部直接调用
- 完全脱离 React 的 VDOM 调和机制，不会被抹掉

### C.3 集成诊断面板到 BoardDock

**修改文件**：`src/components/BoardDock.tsx`

```typescript
import { DiagnosticsPanel } from './DiagnosticsPanel';

// 在数据管理区下方添加诊断区
{showSettings && settingsView === 'DATA' && (
  <>
    {/* 原有的数据管理区 */}
    
    {/* 新增诊断区 */}
    <DiagnosticsPanel />
  </>
)}
```

### C.4 开开发环境日志输出

**修改文件**：`src/utils/performance.ts`

```typescript
// 用 PerformanceObserver 收集慢路径
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    if (entry.duration > SLOW_PATH_THRESHOLD.RENDER) {
      console.warn(
        `[慢路径] ${entry.name}: ${entry.duration}ms`,
        entry
      );
      
      // 记录到诊断收集器
      diagnostics.recordSlowPath(entry.name, entry.duration);
    }
  }
});

observer.observe({ entryTypes: ['measure', 'navigation'] });
```

---

## 4. 文件变更清单

| 操作 | 文件路径                             | 说明                        |
| ---- | ------------------------------------ | --------------------------- |
| **新建** | `src/test/fixtures/sampleData.ts`      | 测试数据工厂                |
| **新建** | `src/test/fixtures/sampleData.test.ts` | 样本生成测试                |
| **新建** | `src/constants/performance.ts`         | 性能预算常量                |
| **新建** | `src/utils/performance.ts`             | 真实性能测量工具             |
| **新建** | `src/utils/diagnostics.ts`             | 独立诊断收集器              |
| **新建** | `src/components/DiagnosticsMetric.tsx` | 防弹容器组件（memo锁死）      |
| **新建** | `src/components/DiagnosticsPanel.tsx`  | 脱离 React 的诊断面板        |
| **修改** | `vite.config.ts`                       | 强制使用 profiling 版本的 React DOM |
| **修改** | `src/store/useStore.ts`                | 使用 User Timing API + 跨端时钟对齐 |
| **修改** | `src/components/Canvas.tsx`            | 使用 React.Profiler + FPS 监控 |
| **修改** | `src/components/BoardDock.tsx`         | 集成诊断面板                |
| **修改** | `src/components/Spotlight.tsx`         | 使用 User Timing API 测量    |
| **修改** | `src-tauri/src/persistence.rs`         | Rust 侧自测 I/O 耗时并返回   |

---

## 5. 验收标准

### A. 固定规模性能样本
- [ ] 可生成 100/500/1000/3000 条便签样本

- [ ] 覆盖密集、（单看板）、分散（多看板）、长文本、废纸篓场景
- [ ] 样本可序列化，可用于测试
- [ ] 画布具备视口裁剪能力，避免 DOM 爆炸
- [ ] 独立测量数据传输 vs 渲染耗时

### B. 性能预算
- [ ] 性能预算常量定义完整
- [ ] 使用 React.Profiler 测量真实渲染耗时（**生产环境需配置 profiling 版本**）
- [ ] 使用 User Timing API 测量 IPC 总耗时
- [ ] **跨端时钟对齐**：Rust 侧自测并返回真实 I/O 耗时
- [ ] FPS 监控有效，可检测掉帧
- [ ] 关键路径埋点生效（保存、搜索、拖拽、平移）
- [ ] 可识别慢路径（超过阈值）
- [ ] **可区分 IPC 开销与 I/O 开销**

### C. 轻量诊断面板
- [ ] 诊断面板脱离 React 管线，不触发 Store 更新
- [ ] **使用防弹容器组件（memo锁死 + 无props + ref直接操作）**
- [ ] 便签统计准确（总计/当前/选中/废纸篓）
- [ ] 性能指标展示（保存/搜索/FPS/掉帧）
- [ ] **诊断数据不会被 React 调和机制抹掉**
- [ ] 慢路径提示可见

---

## 6. 执行顺序

```
A.1 创建测试数据工厂
  ↓
A.2 画布虚拟化检查（确保 Canvas 具备视口裁剪）
  ↓
A.3 独立耗时分离设计
  ↓
A.4 创建样本生成测试
  ↓
B.1 性能预算常量
  ↓
B.2 真实性能测量工具（React.Profiler + User Timing + FPS）
  ↓
B.3 关键路径埋点（Canvas + useStore + Spotlight）
  ↓
C.1 独立诊断数据收集器（不依赖 Zustand）
  ↓
C.2 脱离 React 的诊断面板（useRef + Vanilla JS）
  ↓
C.3 集成诊断面板到 BoardDock
  ↓
C.4 开发环境日志输出（PerformanceObserver）
  ↓
验证所有验收标准
```

---

## 7. 技术选型说明

### 为什么选择 React.Profiler？
- **真实性**：`actualDuration` 包含调和和 DOM 绘制耗时
- **标准**：React 官方推荐的性能测量 API
- **细粒度**：可追踪具体组件的渲染开销

**⚠️ 重要：生产环境 Profiler 配置（必须用环境变量控制）**
React 默认在生产构建中剔除 Profiling 代码。但**绝不能全局启用**，必须按需控制：

```typescript
// vite.config.ts
export default defineConfig({
  resolve: {
    alias: process.env.ENABLE_PROFILING === 'true' ? {
      // 仅在诊断构建时启用 profiling 版本
      'react-dom': 'react-dom/profiling',
    } : {}
  },
  // ... 其他配置
});
```

**为什么不能用全局 alias？**
- Profiler 版本即使不挂载 `<Profiler>` 也会增加内存和 CPU 开销
- 必须在压测基线时启用，生产发布时关闭
- 通过 `ENABLE_PROFILING=true npm run tauri build` 控制

### 为什么选择 User Timing API？
- **原生**：浏览器标准 API，无额外依赖
- **可拆解**：可细分 IPC 序列化、传输、响应各阶段
- **可见性**：可配合 Chrome DevTools Performance 面板分析

**⚠️ 重要：跨端时钟对齐**
前端 `performance.mark()` 测量的是往返总耗时，包含：
- JS 对象序列化
- 跨边界通讯
- **Rust 物理 I/O 落盘**
- 跨边界返回
- JS 反序列化

必须让 Rust 侧"自证清白"：

```rust
// Rust 侧使用 std::time::Instant
let start = std::time::Instant::now();
// ... 执行 fsync、rename 等 I/O 操作
let io_duration = start.elapsed().as_millis() as u64;

// 将纯净 I/O 耗时返回前端
SaveResult { 
  success: true, 
  io_duration_ms: io_duration,
  // ...
}
```

前端计算：**真实的 IPC 开销 = 前端 User Timing 总耗时 - Rust 返回的 io_duration_ms**

### 为什么诊断面板要脱敏？
- **零干扰**：诊断数据更新不应触发业务组件重渲染
- **高频友好**：FPS 等高频指标需要 1s 更新一次，不能进入 Store
- **隔离性**：诊断问题不会因为诊断工具本身而失真

---

**规划人：** OpenCode / Sisyphus  
**规划日期：** 2026-04-20  
**修订日期：** 2026-04-20
