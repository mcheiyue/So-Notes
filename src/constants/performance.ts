/**
 * v1.3.1 性能预算
 * 定义各关键路径的耗时阈值，用于识别慢路径
 */

// 渲染性能预算（React.Profiler actualDuration）
export const RENDER_BUDGETS = {
  // Canvas 主画布：16ms 目标（60fps 帧时间）
  CANVAS_RENDER: 16,
  
  // 单便签渲染：0.5ms，100 条便签总预算 50ms
  NOTE_RENDER: 0.5,
  
  // 便签列表整体渲染：大规模样本需要更宽松
  NOTES_LIST_100: 20,
  NOTES_LIST_500: 80,
  NOTES_LIST_1000: 150,
  NOTES_LIST_3000: 300,
  
  // BoardDock 侧边栏：50ms 上限
  BOARD_DOCK_RENDER: 50,
  
  // Spotlight 搜索面板：30ms 上限
  SPOTLIGHT_RENDER: 30,
};

// IPC 通信性能预算（User Timing API）
export const IPC_BUDGETS = {
  // 序列化耗时：与数据量相关
  SERIALIZATION_100: 5,
  SERIALIZATION_500: 20,
  SERIALIZATION_1000: 50,
  SERIALIZATION_3000: 150,
  
  // IPC 往返总耗时（包含 Rust 物理 I/O）
  IPC_ROUNDTRIP: 100,
  
  // Rust 纯净 I/O 耗时（扣除序列化后的真实文件系统耗时）
  RUST_IO_PUR: 50,
  
  // 前端计算开销（序列化 + JS 处理）
  FRONTEND_OVERHEAD: 50,
};

// 交互性能预算
export const INTERACTION_BUDGETS = {
  // 拖拽操作：必须维持 60fps
  DRAG_FPS: 60,
  DRAG_FRAME_TIME: 16.67,
  
  // 平移操作：同样 60fps 要求
  PAN_FPS: 60,
  PAN_FRAME_TIME: 16.67,
  
  // 搜索响应：从输入到结果展示的端到端耗时
  SEARCH_RESPONSE: 50,
  
  // 保存响应：用户感知到的保存反馈延迟
  SAVE_FEEDBACK: 100,
};

// 慢路径阈值（超过此值记录警告）
export const SLOW_PATH_THRESHOLDS = {
  // 渲染慢路径
  RENDER_SLOW: 50,
  RENDER_VERY_SLOW: 100,
  
  // IPC 慢路径
  IPC_SLOW: 100,
  IPC_VERY_SLOW: 500,
  
  // 交互慢路径
  INTERACTION_SLOW: 32, // 低于 30fps
  INTERACTION_VERY_SLOW: 100,
};

// 诊断面板配置
export const DIAGNOSTICS_CONFIG = {
  // 更新间隔（ms）
  UPDATE_INTERVAL: 1000,
  
  // FPS 采样窗口大小
  FPS_SAMPLE_SIZE: 60,
  
  // 掉帧阈值（帧时间超过此值视为掉帧）
  JANK_THRESHOLD: 33.33, // 低于 30fps
  
  // 慢路径历史保留数量
  SLOW_PATH_HISTORY: 10,
};

// 测试规模样本配置
export const TEST_SAMPLE_SIZES = {
  SMALL: 100,
  MEDIUM: 500,
  LARGE: 1000,
  STRESS: 3000,
};
